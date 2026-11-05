//! Terminal inspector runtime.
//!
//! Source reads run in independent Aven/store (5 s) and Herdr/API (2 s)
//! background lanes. Rendering and input only consume immutable updates, so a
//! stalled source cannot freeze help, resize or quit.

mod navigation;
mod state;
mod view;

use anyhow::{Context, Result, bail};
use crossterm::{
    cursor::{Hide, Show},
    event::{self, Event, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};
use std::{
    env, fs,
    io::{self, IsTerminal},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{SyncSender, TrySendError, sync_channel},
    },
    thread,
    time::{Duration, Instant},
};

use crate::inspect::{
    model::*,
    sources::{self, BaseRead, LiveRead, Options},
};

use self::state::{Action, UiState};

const BASE_INTERVAL: Duration = Duration::from_secs(5);
const LIVE_INTERVAL: Duration = Duration::from_secs(2);
const TICK: Duration = Duration::from_millis(100);
const FIXTURE_LIMIT: u64 = 8 * 1024 * 1024;

pub(crate) struct Args {
    pub(crate) project: Option<String>,
    pub(crate) workspace: Option<String>,
    pub(crate) cwd: PathBuf,
    pub(crate) store: PathBuf,
}

pub(crate) fn run(args: Args) -> Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        bail!(
            "tui requires an interactive terminal; use `aven-dispatch inspect --json` for non-interactive inspection"
        );
    }
    let fixture = env::var_os("AVEN_DISPATCH_TUI_FIXTURE").map(PathBuf::from);
    let options = Options {
        project: args.project,
        workspace: args.workspace,
        cwd: args.cwd,
        store: args.store,
        ..Default::default()
    };
    let _guard = TerminalGuard::new()?;
    let backend = CrosstermBackend::new(io::stdout());
    let mut terminal = Terminal::new(backend).context("initialize inspector terminal")?;
    let result = match fixture {
        Some(path) => run_fixture(&mut terminal, &path),
        None => run_live(&mut terminal, options),
    };
    let _ = terminal.show_cursor();
    result
}

enum LaneUpdate {
    Base(Result<BaseRead, String>),
    Live(LiveRead),
}

#[derive(Default)]
struct Shared {
    scope: Mutex<Option<Scope>>,
    attempts: Mutex<Vec<AttemptRecord>>,
    priority: Mutex<Option<String>>,
    cancel: AtomicBool,
    refresh_base: AtomicBool,
    refresh_live: AtomicBool,
}

fn run_live(terminal: &mut Terminal<CrosstermBackend<io::Stdout>>, options: Options) -> Result<()> {
    let (sender, receiver) = sync_channel::<LaneUpdate>(8);
    let shared = Arc::new(Shared::default());
    let base_handle = spawn_base_lane(Arc::clone(&shared), sender.clone(), options.clone());
    let live_handle = spawn_live_lane(Arc::clone(&shared), sender);
    let mut model = Model::new(empty_snapshot());
    let result = event_loop(terminal, &mut model, &receiver, Some(&shared));
    shared.cancel.store(true, Ordering::SeqCst);
    // Never join: a source read may still be inside its bounded four-second
    // call, and quitting must stay responsive. Process exit reclaims the
    // detached workers; the cancel flag stops them otherwise.
    drop(base_handle);
    drop(live_handle);
    result
}

fn spawn_base_lane(
    shared: Arc<Shared>,
    sender: SyncSender<LaneUpdate>,
    mut options: Options,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut next = Instant::now();
        while !shared.cancel.load(Ordering::SeqCst) {
            let due = Instant::now() >= next || shared.refresh_base.swap(false, Ordering::SeqCst);
            if due {
                next = Instant::now() + BASE_INTERVAL;
                options.priority_task = shared.priority.lock().expect("priority lock").clone();
                let result = sources::read_base(&options).map_err(|error| format!("{error:#}"));
                if let Ok(base) = &result {
                    *shared.scope.lock().expect("scope lock") = Some(base.scope.clone());
                    *shared.attempts.lock().expect("attempt lock") = base.attempts.clone();
                    // Force the live lane to reconcile against the new
                    // attempts without waiting for its full interval.
                    shared.refresh_live.store(true, Ordering::SeqCst);
                }
                // Contexts are cached across cycles; the next read only spawns
                // `aven context` for missing, changed, or aged-out tasks.
                let update = match result {
                    Ok(base) => LaneUpdate::Base(Ok(base)),
                    Err(error) => LaneUpdate::Base(Err(error)),
                };
                match sender.try_send(update) {
                    Ok(()) | Err(TrySendError::Disconnected(_)) => {}
                    Err(TrySendError::Full(_)) => {}
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    })
}

fn spawn_live_lane(shared: Arc<Shared>, sender: SyncSender<LaneUpdate>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut next = Instant::now();
        while !shared.cancel.load(Ordering::SeqCst) {
            let due = Instant::now() >= next || shared.refresh_live.swap(false, Ordering::SeqCst);
            if due {
                next = Instant::now() + LIVE_INTERVAL;
                let scope = shared.scope.lock().expect("scope lock").clone();
                let attempts = shared.attempts.lock().expect("attempt lock").clone();
                if let Some(scope) = scope {
                    let live = sources::read_live(&scope, &attempts);
                    match sender.try_send(LaneUpdate::Live(live)) {
                        Ok(()) | Err(TrySendError::Disconnected(_)) => {}
                        Err(TrySendError::Full(_)) => {}
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
    })
}

fn run_fixture(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    path: &PathBuf,
) -> Result<()> {
    let metadata =
        fs::metadata(path).with_context(|| format!("read inspector fixture {}", path.display()))?;
    if !metadata.is_file() || metadata.len() > FIXTURE_LIMIT {
        bail!("inspector fixture is not a bounded file");
    }
    let raw = fs::read_to_string(path).context("read inspector fixture")?;
    let snapshot: Snapshot =
        serde_json::from_str(&raw).context("inspector fixture is not a valid snapshot")?;
    let mut model = Model::new(snapshot);
    event_loop(terminal, &mut model, &sync_channel(1).1, None)
}

#[derive(Default)]
struct FocusGate {
    pending: bool,
}

impl FocusGate {
    /// Admit exactly one navigation effect until its result is consumed.
    fn admit(&mut self) -> bool {
        if self.pending {
            false
        } else {
            self.pending = true;
            true
        }
    }
    fn complete(&mut self) {
        self.pending = false;
    }
}

struct Model {
    base: Option<BaseRead>,
    live: Option<LiveRead>,
    snapshot: Snapshot,
    dirty: bool,
    first_base: bool,
}

impl Model {
    fn new(snapshot: Snapshot) -> Self {
        Self {
            base: None,
            live: None,
            snapshot,
            dirty: true,
            first_base: true,
        }
    }
    fn apply(&mut self, update: LaneUpdate, state: &mut UiState) {
        match update {
            LaneUpdate::Base(Ok(base)) => {
                self.base = Some(base);
                if self.first_base {
                    state.status = "Inspector snapshot loaded.".into();
                    self.first_base = false;
                }
                self.rebuild(state);
            }
            LaneUpdate::Base(Err(error)) => {
                if let Some(base) = &mut self.base {
                    for health in &mut base.sources {
                        mark_stale(health, &error);
                    }
                    state.status = format!(
                        "Aven/store refresh failed; showing last good data: {}",
                        truncate(&error, 120)
                    );
                    self.rebuild(state);
                } else {
                    state.status = format!("Aven/store unavailable: {}", truncate(&error, 160));
                }
            }
            LaneUpdate::Live(live) => {
                self.live = Some(match self.live.take() {
                    Some(previous) => merge_live(previous, live),
                    None => live,
                });
                self.rebuild(state);
            }
        }
    }
    fn rebuild(&mut self, state: &mut UiState) {
        if let Some(base) = &self.base {
            let live = self.live.clone().unwrap_or_default();
            self.snapshot = sources::assemble(base, &live);
        }
        expire_activity(&mut self.snapshot, crate::process::now());
        state.set_snapshot(&self.snapshot);
        self.dirty = true;
    }
}

fn merge_live(previous: LiveRead, mut next: LiveRead) -> LiveRead {
    let mut previous = previous;
    for health in &mut next.sources {
        match health.source.as_str() {
            "core" if health.status != HealthStatus::Ok => {
                next.panes = std::mem::take(&mut previous.panes);
                next.workspaces = std::mem::take(&mut previous.workspaces);
                next.worktrees = std::mem::take(&mut previous.worktrees);
                mark_stale(health, "herdr-core refresh failed");
            }
            "opencode" if health.status == HealthStatus::Unavailable => {
                next.sessions = std::mem::take(&mut previous.sessions);
                mark_stale(health, "OpenCode refresh failed");
            }
            _ => {}
        }
    }
    next
}

fn mark_stale(health: &mut SourceHealth, reason: &str) {
    health.status = HealthStatus::Stale;
    if !health.message.contains("last good") {
        health.message = format!(
            "{}; last good observation retained: {}",
            truncate(reason, 120),
            health.message
        );
    }
}

fn expire_activity(snapshot: &mut Snapshot, now: u64) -> bool {
    let mut changed = false;
    for session in &mut snapshot.sessions {
        if session.api.freshness == Freshness::Current
            && session.api.expires_at_ms > 0
            && now >= session.api.expires_at_ms
        {
            session.api.freshness = Freshness::Expired;
            session.api.state = ApiState::Unknown;
            session.api.approval_waiting = Tri::Unknown;
            session.api.input_waiting = Tri::Unknown;
            changed = true;
        }
    }
    changed
}

fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    model: &mut Model,
    receiver: &std::sync::mpsc::Receiver<LaneUpdate>,
    shared: Option<&Arc<Shared>>,
) -> Result<()> {
    let mut state = UiState::default();
    state.set_snapshot(&model.snapshot);
    let mut last_priority: Option<String> = None;
    let (navigation_sender, navigation_receiver) = std::sync::mpsc::channel::<Result<(), String>>();
    let mut focus_gate = FocusGate::default();
    loop {
        while let Ok(update) = receiver.try_recv() {
            model.apply(update, &mut state);
        }
        while let Ok(result) = navigation_receiver.try_recv() {
            focus_gate.complete();
            match result {
                Ok(()) => {
                    state.status = "Focus request completed; inspector remains active.".into();
                }
                Err(error) => {
                    state.status = format!(
                        "Focus failed: {}",
                        crate::inspect::model::sanitize(&error, 240, &[])
                    )
                }
            }
            model.dirty = true;
        }
        if expire_activity(&mut model.snapshot, crate::process::now()) {
            state.set_snapshot(&model.snapshot);
            model.dirty = true;
        }
        if event::poll(TICK)? {
            match event::read()? {
                Event::Key(key) if key.kind != KeyEventKind::Release => {
                    match state.reduce(key, &model.snapshot) {
                        Action::Quit => break,
                        Action::Focus => {
                            if !focus_gate.admit() {
                                let _ = state.take_focus_request();
                                state.status = "A focus request is already pending.".into();
                            } else if let Some(candidate) = state.take_focus_request() {
                                let sender = navigation_sender.clone();
                                thread::spawn(move || {
                                    let result =
                                        crate::tui::navigation::focus_candidate(&candidate)
                                            .map_err(|error| format!("{error:#}"));
                                    let _ = sender.send(result);
                                });
                            }
                        }
                        Action::Refresh => {
                            if let Some(shared) = shared {
                                shared.refresh_base.store(true, Ordering::SeqCst);
                                shared.refresh_live.store(true, Ordering::SeqCst);
                                state.status = "Refresh requested.".into();
                            } else {
                                state.status =
                                    "Fixture snapshot; refresh is disabled in fixture mode.".into();
                            }
                        }
                        Action::None => {}
                    }
                    model.dirty = true;
                }
                Event::Resize(_, _) => model.dirty = true,
                _ => {}
            }
        }
        if let Some(shared) = shared {
            let priority = state.selected_row().and_then(|row| row.task_id.clone());
            if priority != last_priority {
                last_priority = priority.clone();
                *shared.priority.lock().expect("priority lock") = priority;
                if last_priority.is_some() {
                    shared.refresh_base.store(true, Ordering::SeqCst);
                }
            }
        }
        if model.dirty {
            terminal.draw(|frame| view::draw(frame, &mut state, &model.snapshot))?;
            model.dirty = false;
        }
    }
    Ok(())
}

fn empty_snapshot() -> Snapshot {
    Snapshot {
        schema: SCHEMA.into(),
        observed_at_ms: crate::process::now(),
        scope: Scope {
            project: "resolving…".into(),
            workspace: "resolving…".into(),
            repository: "resolving…".into(),
            cwd: "resolving…".into(),
            project_source: "pending".into(),
            workspace_source: "pending".into(),
            core_session: "hc".into(),
        },
        limits: Limits::default(),
        sources: ["aven", "dispatcher", "core", "opencode"]
            .into_iter()
            .map(|source| SourceHealth::unavailable(source, "Initial read pending."))
            .collect(),
        tasks: Vec::new(),
        attempts: Vec::new(),
        sessions: Vec::new(),
        panes: Vec::new(),
        workspaces: Vec::new(),
        worktrees: Vec::new(),
        candidates: Vec::new(),
        relationships: Vec::new(),
        conflicts: Vec::new(),
        warnings: Vec::new(),
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_owned()
    } else {
        let mut output = value
            .chars()
            .take(max.saturating_sub(1))
            .collect::<String>();
        output.push('…');
        output
    }
}

struct TerminalGuard {
    active: bool,
}

impl TerminalGuard {
    fn new() -> Result<Self> {
        enable_raw_mode().context("enable terminal raw mode")?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen, Hide) {
            let _ = disable_raw_mode();
            return Err(error).context("enter alternate screen");
        }
        Ok(Self { active: true })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if self.active {
            let _ = disable_raw_mode();
            let _ = execute!(io::stdout(), LeaveAlternateScreen, Show);
        }
        self.active = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_focus_admission_is_suppressed_until_completion() {
        let mut gate = FocusGate::default();
        assert!(gate.admit());
        assert!(!gate.admit());
        gate.complete();
        assert!(gate.admit());
    }

    #[test]
    fn activity_expires_after_the_ttl_and_never_reports_idle() {
        let mut snapshot = empty_snapshot();
        snapshot.sessions.push(SessionRecord {
            session_id: "ses_one".into(),
            roles: vec![SessionRole::Primary],
            task_ids: vec!["task-one".into()],
            task_refs: vec!["APP-1".into()],
            workflows: vec!["implementation".into()],
            attempt_ids: vec!["a1".into()],
            pane: None,
            api: ApiActivity {
                state: ApiState::Working,
                freshness: Freshness::Current,
                observed_at_ms: 1,
                expires_at_ms: 4_501,
                approval_waiting: Tri::Yes,
                input_waiting: Tri::No,
                parent_id: None,
            },
        });
        assert!(!expire_activity(&mut snapshot, 4_500));
        assert_eq!(snapshot.sessions[0].api.state, ApiState::Working);
        assert!(expire_activity(&mut snapshot, 4_501));
        assert_eq!(snapshot.sessions[0].api.state, ApiState::Unknown);
        assert_eq!(snapshot.sessions[0].api.freshness, Freshness::Expired);
        assert_eq!(snapshot.sessions[0].api.approval_waiting, Tri::Unknown);
    }

    #[test]
    fn unavailable_live_refresh_preserves_last_good_rows_and_marks_stale() {
        let mut previous = LiveRead::default();
        previous.panes.push(PaneRecord {
            pane_id: "w1:p1".into(),
            workspace_id: "w1".into(),
            tab_id: "w1:t1".into(),
            cwd: "/repo".into(),
            agent_profile: None,
            agent_status: "idle".into(),
            agent_session_id: None,
            focused: false,
        });
        previous.sources.push(SourceHealth::ok("core", "ok"));
        let mut next = LiveRead::default();
        next.sources.push(SourceHealth::unavailable("core", "down"));
        let merged = merge_live(previous, next);
        assert_eq!(merged.panes.len(), 1);
        assert_eq!(merged.sources[0].status, HealthStatus::Stale);
        assert!(merged.sources[0].message.contains("last good"));
    }
}
