//! Pure reducer and row projection for the dispatcher inspector.
//!
//! Rendering and source collection stay outside this module: every key press
//! produces a small [`Action`], and every snapshot produces a stable row list
//! with identity-preserving selection.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::widgets::TableState;
use std::fmt::Write as _;

use crate::inspect::model::*;

use super::navigation::{self, Candidate};

const SEARCH_LIMIT: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum View {
    Overview,
    Tasks,
    Attempts,
    Sessions,
    Panes,
}

impl View {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Overview => "overview",
            Self::Tasks => "tasks",
            Self::Attempts => "attempts",
            Self::Sessions => "sessions",
            Self::Panes => "terminals",
        }
    }
    pub(crate) fn from_command(value: &str) -> Option<Self> {
        match value {
            "overview" => Some(Self::Overview),
            "tasks" | "task" | "epics" => Some(Self::Tasks),
            "attempts" | "attempt" => Some(Self::Attempts),
            "sessions" | "session" | "agents" => Some(Self::Sessions),
            "terminals" | "terminal" | "panes" | "pane" | "workspaces" => Some(Self::Panes),
            _ => None,
        }
    }
    pub(crate) fn headers(self) -> Vec<&'static str> {
        match self {
            Self::Overview | Self::Tasks => {
                vec!["REF", "TITLE", "STATUS", "PLAN", "ATTEMPTS"]
            }
            Self::Attempts => {
                vec![
                    "REF", "WORKFLOW", "MODE", "STATE", "ORIGIN", "SESSION", "PANE",
                ]
            }
            Self::Sessions => {
                vec!["SESSION", "ROLE", "TASK", "WORKFLOW", "API", "WAIT", "PANE"]
            }
            Self::Panes => {
                vec![
                    "KIND",
                    "ID",
                    "WORKSPACE",
                    "TAB",
                    "AGENT",
                    "STATUS",
                    "WORKTREE",
                ]
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InputMode {
    None,
    Search,
    Command,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Action {
    None,
    Quit,
    Refresh,
    Focus,
}

#[derive(Debug, Clone)]
pub(crate) struct Chooser {
    pub(crate) candidates: Vec<Candidate>,
    pub(crate) index: usize,
}

impl Chooser {
    pub(crate) fn selected(&self) -> Option<&Candidate> {
        self.candidates.get(self.index)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RowKind {
    Task,
    Attempt,
    Session,
    Pane,
    Workspace,
}

#[derive(Debug, Clone)]
pub(crate) struct Row {
    pub(crate) key: String,
    pub(crate) task_id: Option<String>,
    pub(crate) kind: RowKind,
    pub(crate) cells: Vec<String>,
    pub(crate) state: String,
    pub(crate) is_epic: bool,
    pub(crate) search: String,
    pub(crate) detail: Vec<String>,
}

pub(crate) struct UiState {
    pub(crate) view: View,
    pub(crate) rows: Vec<Row>,
    pub(crate) table: TableState,
    pub(crate) input_mode: InputMode,
    pub(crate) input: String,
    pub(crate) search: String,
    pub(crate) search_backup: String,
    pub(crate) state_filter: String,
    pub(crate) epic_only: bool,
    pub(crate) sort_descending: bool,
    pub(crate) details: bool,
    pub(crate) help: bool,
    pub(crate) chooser: Option<Chooser>,
    pub(crate) status: String,
    pub(crate) all_states: Vec<String>,
    all_rows_cache: Vec<Row>,
    last_key: Option<String>,
    focus_request: Option<Candidate>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            view: View::Overview,
            rows: Vec::new(),
            table: TableState::default(),
            input_mode: InputMode::None,
            input: String::new(),
            search: String::new(),
            search_backup: String::new(),
            state_filter: String::new(),
            epic_only: false,
            sort_descending: false,
            details: false,
            help: false,
            chooser: None,
            status: String::new(),
            all_states: Vec::new(),
            all_rows_cache: Vec::new(),
            last_key: None,
            focus_request: None,
        }
    }
}

impl UiState {
    /// Replace the projected rows while preserving the selected immutable
    /// identity. A disappeared identity clears selection; it never jumps to a
    /// different execution that happens to share the row index.
    pub(crate) fn set_snapshot(&mut self, snapshot: &Snapshot) {
        let previous = self.selected_key().or_else(|| self.last_key.clone());
        let mut all = self.all_rows(snapshot);
        for row in &mut all {
            row.state = sanitize(&row.state, 128, &[]);
            for cell in &mut row.cells {
                *cell = sanitize(cell, 1024, &[]);
            }
            for line in &mut row.detail {
                *line = sanitize(line, 4096, &[]);
            }
        }
        self.all_rows_cache = all.clone();
        self.all_states = all
            .iter()
            .map(|row| row.state.clone())
            .filter(|state| !state.is_empty())
            .collect::<Vec<_>>();
        self.all_states.sort();
        self.all_states.dedup();
        self.rows = filter_rows(all, &self.search, &self.state_filter, self.epic_only);
        if self.sort_descending {
            self.rows
                .sort_by(|left, right| right.cells.cmp(&left.cells));
        } else {
            self.rows
                .sort_by(|left, right| left.cells.cmp(&right.cells));
        }
        if let Some(previous) = previous {
            match self.rows.iter().position(|row| row.key == previous) {
                Some(index) => {
                    self.table.select(Some(index));
                    self.last_key = Some(previous);
                }
                None => {
                    self.table.select(None);
                    self.last_key = None;
                    if self.rows.is_empty() {
                        self.status =
                            format!("No {} rows match the current filters.", self.view.label());
                    } else {
                        self.status =
                            "The selected record disappeared; selection was cleared.".into();
                    }
                }
            }
        } else if self.rows.is_empty() {
            self.table.select(None);
        } else {
            self.table.select(Some(0));
            self.last_key = self.rows.first().map(|row| row.key.clone());
        }
    }

    pub(crate) fn selected_row(&self) -> Option<&Row> {
        self.table.selected().and_then(|index| self.rows.get(index))
    }

    fn selected_key(&self) -> Option<String> {
        self.selected_row().map(|row| row.key.clone())
    }

    fn remember_selection(&mut self) {
        self.last_key = self.selected_key();
    }

    fn move_selection(&mut self, delta: isize) {
        if self.rows.is_empty() {
            self.table.select(None);
            return;
        }
        let current = self.table.selected().unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, self.rows.len() as isize - 1) as usize;
        self.table.select(Some(next));
        self.remember_selection();
    }

    fn move_to(&mut self, index: usize) {
        if self.rows.is_empty() {
            self.table.select(None);
            return;
        }
        self.table.select(Some(index.min(self.rows.len() - 1)));
        self.remember_selection();
    }

    pub(crate) fn reduce(&mut self, key: KeyEvent, snapshot: &Snapshot) -> Action {
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return Action::Quit;
        }
        if self.chooser.is_some() {
            return self.reduce_chooser(key);
        }
        if self.help {
            if matches!(
                key.code,
                KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q')
            ) {
                self.help = false;
            }
            return Action::None;
        }
        if self.input_mode != InputMode::None {
            return self.reduce_input(key, snapshot);
        }
        if self.details && matches!(key.code, KeyCode::Esc | KeyCode::Char('i')) {
            self.details = false;
            return Action::None;
        }
        match key.code {
            KeyCode::Char('q') => return Action::Quit,
            KeyCode::Char('?') => self.help = true,
            KeyCode::Esc => {
                if !self.search.is_empty() {
                    self.search.clear();
                    self.status = "Search cleared.".into();
                } else if !self.state_filter.is_empty() {
                    self.state_filter.clear();
                    self.status = "State filter cleared.".into();
                } else if self.epic_only {
                    self.epic_only = false;
                    self.status = "Epic filter cleared.".into();
                } else if self.details {
                    self.details = false;
                } else {
                    self.status.clear();
                }
                self.reproject(snapshot);
            }
            KeyCode::Char('/') => {
                self.search_backup = self.search.clone();
                self.input = self.search.clone();
                self.input_mode = InputMode::Search;
            }
            KeyCode::Char(':') => {
                self.input.clear();
                self.input_mode = InputMode::Command;
            }
            KeyCode::Char('r') => return Action::Refresh,
            KeyCode::Char('i') => self.details = !self.details,
            KeyCode::Char('f') => self.cycle_state_filter(),
            KeyCode::Char('e') => {
                self.epic_only = !self.epic_only;
                self.status = if self.epic_only {
                    "Epic filter enabled.".into()
                } else {
                    "Epic filter disabled.".into()
                };
                self.reproject(snapshot);
            }
            KeyCode::Char('S') => {
                self.sort_descending = !self.sort_descending;
                self.status = if self.sort_descending {
                    "Descending sort.".into()
                } else {
                    "Ascending sort.".into()
                };
                self.reproject(snapshot);
            }
            KeyCode::Down | KeyCode::Char('j') => self.move_selection(1),
            KeyCode::Up | KeyCode::Char('k') => self.move_selection(-1),
            KeyCode::PageDown => self.move_selection(10),
            KeyCode::PageUp => self.move_selection(-10),
            KeyCode::Home => self.move_to(0),
            KeyCode::End => self.move_to(self.rows.len().saturating_sub(1)),
            KeyCode::Enter => {
                return self.begin_navigation(snapshot);
            }
            _ => {}
        }
        Action::None
    }

    fn reduce_input(&mut self, key: KeyEvent, snapshot: &Snapshot) -> Action {
        match key.code {
            KeyCode::Esc => {
                if self.input_mode == InputMode::Search {
                    self.input = self.search_backup.clone();
                }
                self.input_mode = InputMode::None;
                self.input.clear();
            }
            KeyCode::Enter => {
                let mode = self.input_mode;
                self.input_mode = InputMode::None;
                match mode {
                    InputMode::Search => {
                        self.search = self.input.trim().to_owned();
                        self.input.clear();
                        self.status = if self.search.is_empty() {
                            "Search cleared.".into()
                        } else {
                            format!("Search: {}", self.search)
                        };
                        // Same view: reproject from the cached authoritative
                        // rows so clearing the search restores them.
                        self.reproject_from_last();
                    }
                    InputMode::Command => {
                        let command = self.input.trim().to_owned();
                        self.input.clear();
                        if let Some(view) = View::from_command(&command) {
                            self.view = view;
                            // Deliberate view changes begin with no identity
                            // from the previous resource type.
                            self.table.select(None);
                            self.last_key = None;
                            self.status = format!("view: {}", view.label());
                            self.reproject(snapshot);
                        } else if command.is_empty() {
                            self.status.clear();
                        } else {
                            self.status = format!(
                                "Unknown view command {:?}; use overview, tasks, attempts, sessions or terminals.",
                                truncate(&command, 32)
                            );
                        }
                    }
                    InputMode::None => {}
                }
            }
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(character)
                if !key.modifiers.contains(KeyModifiers::CONTROL)
                    && self.input.chars().count() < SEARCH_LIMIT =>
            {
                self.input.push(character);
            }
            _ => {}
        }
        Action::None
    }

    fn reduce_chooser(&mut self, key: KeyEvent) -> Action {
        let Some(chooser) = &mut self.chooser else {
            return Action::None;
        };
        match key.code {
            KeyCode::Esc | KeyCode::Char('q') => {
                self.chooser = None;
                self.status = "Navigation canceled; no pane was focused.".into();
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if !chooser.candidates.is_empty() {
                    chooser.index = (chooser.index + 1).min(chooser.candidates.len() - 1);
                }
            }
            KeyCode::Up | KeyCode::Char('k') => {
                chooser.index = chooser.index.saturating_sub(1);
            }
            KeyCode::Home => chooser.index = 0,
            KeyCode::End => {
                chooser.index = chooser.candidates.len().saturating_sub(1);
            }
            KeyCode::Enter => {
                let candidate = chooser.selected().cloned();
                self.chooser = None;
                if let Some(candidate) = candidate {
                    self.status = format!("Focusing pane {}…", candidate.pane_id);
                    self.focus_request = Some(candidate);
                    return Action::Focus;
                }
            }
            _ => {}
        }
        Action::None
    }

    pub(crate) fn take_focus_request(&mut self) -> Option<Candidate> {
        self.focus_request.take()
    }

    fn begin_navigation(&mut self, snapshot: &Snapshot) -> Action {
        let Some(row) = self.selected_row().cloned() else {
            self.status = "Select a resource row before pressing Enter.".into();
            return Action::None;
        };
        let resolution = navigation::resolve(snapshot, &row);
        match resolution.candidates.as_slice() {
            [] => {
                self.status = resolution
                    .reason
                    .unwrap_or_else(|| "No explicitly owned pane is available.".into());
                Action::None
            }
            [candidate] => {
                self.status = format!("Focusing pane {}…", candidate.pane_id);
                self.focus_request = Some(candidate.clone());
                Action::Focus
            }
            candidates => {
                self.status = format!(
                    "{} candidate panes; choose one with j/k and Enter (Esc/q cancels).",
                    candidates.len()
                );
                self.chooser = Some(Chooser {
                    candidates: candidates.to_vec(),
                    index: 0,
                });
                Action::None
            }
        }
    }

    fn cycle_state_filter(&mut self) {
        if self.all_states.is_empty() {
            self.status = "No states to filter.".into();
            return;
        }
        if self.state_filter.is_empty() {
            self.state_filter = self.all_states[0].clone();
        } else if let Some(index) = self
            .all_states
            .iter()
            .position(|state| state == &self.state_filter)
        {
            self.state_filter = self.all_states.get(index + 1).cloned().unwrap_or_default();
        } else {
            self.state_filter.clear();
        }
        self.status = if self.state_filter.is_empty() {
            "State filter cleared.".into()
        } else {
            format!("State filter: {}", self.state_filter)
        };
    }

    fn reproject(&mut self, snapshot: &Snapshot) {
        self.set_snapshot(snapshot);
    }

    /// Commands/search mutate only row projection, not source data. Keep the
    /// last projected rows for this narrow path; the next snapshot rebuilds
    /// them from authoritative state.
    fn reproject_from_last(&mut self) {
        let previous = self.selected_key().or_else(|| self.last_key.clone());
        self.rows = filter_rows(
            self.all_rows_cache.clone(),
            &self.search,
            &self.state_filter,
            self.epic_only,
        );
        if self.sort_descending {
            self.rows
                .sort_by(|left, right| right.cells.cmp(&left.cells));
        } else {
            self.rows
                .sort_by(|left, right| left.cells.cmp(&right.cells));
        }
        if let Some(previous) = previous {
            if let Some(index) = self.rows.iter().position(|row| row.key == previous) {
                self.table.select(Some(index));
                self.last_key = Some(previous);
            } else {
                self.table.select(None);
                self.last_key = None;
            }
        } else if !self.rows.is_empty() {
            self.table.select(Some(0));
        }
    }

    fn all_rows(&self, snapshot: &Snapshot) -> Vec<Row> {
        match self.view {
            View::Overview | View::Tasks => task_rows(snapshot),
            View::Attempts => attempt_rows(snapshot),
            View::Sessions => session_rows(snapshot),
            View::Panes => pane_rows(snapshot),
        }
    }
}

fn filter_rows(rows: Vec<Row>, search: &str, state_filter: &str, epic_only: bool) -> Vec<Row> {
    let needle = search.to_lowercase();
    rows.into_iter()
        .filter(|row| needle.is_empty() || row.search.contains(&needle))
        .filter(|row| state_filter.is_empty() || row.state == state_filter)
        .filter(|row| !epic_only || row.is_epic)
        .collect()
}

fn task_rows(snapshot: &Snapshot) -> Vec<Row> {
    snapshot
        .tasks
        .iter()
        .map(|task| {
            let attempts = snapshot
                .attempts
                .iter()
                .filter(|attempt| attempt.task_id == task.id)
                .collect::<Vec<_>>();
            let plan = if task.is_epic {
                "epic".to_owned()
            } else if let Some(phase) = &task.plan.plan_phase {
                format!("phase {phase}")
            } else if task.plan.plan_root.is_some() {
                "planned".to_owned()
            } else {
                "-".to_owned()
            };
            let mut detail = vec![
                format!("task {} ({})", task.reference, task.id),
                format!("title: {}", task.title),
                format!("project: {}  status: {}", task.project, task.status),
                format!(
                    "plan: root={} phase={} kind={} worked_out={} reset_generation={} reset_state={}",
                    task.plan.plan_root.as_deref().unwrap_or("-"),
                    task.plan.plan_phase.as_deref().unwrap_or("-"),
                    task.plan.plan_kind.as_deref().unwrap_or("-"),
                    task.plan.plan_worked_out,
                    task.plan.reset_generation,
                    task.plan.reset_state.as_deref().unwrap_or("-")
                ),
                format!(
                    "context: {} observed_at_ms={}",
                    if task.hydrated { "hydrated" } else { "boundary only" },
                    task.context_observed_at_ms.unwrap_or(0)
                ),
            ];
            for (label, values) in [
                ("depends_on", &task.dependencies),
                ("blocks", &task.blocks),
                ("related", &task.related),
            ] {
                let values = values
                    .iter()
                    .map(|value| {
                        format!(
                            "{}:{}:{}",
                            value.kind,
                            value.reference.as_deref().unwrap_or("-"),
                            if value.hydrated { "hydrated" } else { "boundary" }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                detail.push(format!("{label}: {}", if values.is_empty() { "-" } else { &values }));
            }
            if let Some(parent) = &task.epic_parent {
                detail.push(format!(
                    "epic parent: {} ({})",
                    parent.reference.as_deref().unwrap_or("-"),
                    parent.id
                ));
            }
            if !task.epic_children.is_empty() {
                detail.push(format!(
                    "epic children: {}",
                    task.epic_children
                        .iter()
                        .map(|child| child.reference.as_deref().unwrap_or(&child.id))
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            for attempt in &attempts {
                detail.push(format!(
                    "attempt {} [{}] state={} role-session={} pane={} origin={:?}",
                    attempt.attempt_id,
                    attempt.workflow,
                    attempt.state,
                    if attempt.session_id.is_empty() {
                        "-"
                    } else {
                        &attempt.session_id
                    },
                    if attempt.pane.is_empty() {
                        "-"
                    } else {
                        &attempt.pane
                    },
                    attempt.origin
                ));
            }
            Row {
                key: format!("task:{}", task.id),
                task_id: Some(task.id.clone()),
                kind: RowKind::Task,
                cells: vec![
                    task.reference.clone(),
                    task.title.clone(),
                    task.status.clone(),
                    plan,
                    attempts.len().to_string(),
                ],
                state: task.status.clone(),
                is_epic: task.is_epic,
                search: format!(
                    "{} {} {} {} {}",
                    task.id,
                    task.reference,
                    task.title,
                    task.status,
                    attempts
                        .iter()
                        .map(|attempt| format!("{} {}", attempt.workflow, attempt.state))
                        .collect::<Vec<_>>()
                        .join(" ")
                )
                .to_lowercase(),
                detail,
            }
        })
        .collect()
}

fn attempt_rows(snapshot: &Snapshot) -> Vec<Row> {
    snapshot
        .attempts
        .iter()
        .map(|attempt| {
            let sessions = snapshot
                .sessions
                .iter()
                .filter(|session| session.attempt_ids.contains(&attempt.attempt_id))
                .collect::<Vec<_>>();
            let mut detail = vec![
                format!("attempt {} / {}", attempt.attempt_id, attempt.task_ref),
                format!(
                    "task_id: {}  workflow: {}  generation: {}",
                    attempt.task_id, attempt.workflow, attempt.generation
                ),
                format!(
                    "persisted state: {}  execution_mode: {}  origin: {:?}",
                    attempt.state, attempt.execution_mode, attempt.origin
                ),
                format!(
                    "observed_at_ms: {}  created_at_ms: {}",
                    attempt.observed_at_ms, attempt.created_at_ms
                ),
                format!(
                    "worktree: {}  branch: {}  created_by_attempt: {}",
                    if attempt.worktree.is_empty() {
                        "-"
                    } else {
                        &attempt.worktree
                    },
                    if attempt.branch.is_empty() {
                        "-"
                    } else {
                        &attempt.branch
                    },
                    attempt.worktree_created_by_attempt
                ),
                format!(
                    "agent: {}  model: {}  coordinator: {} ({})",
                    if attempt.agent.is_empty() {
                        "-"
                    } else {
                        &attempt.agent
                    },
                    if attempt.model.is_empty() {
                        "-"
                    } else {
                        &attempt.model
                    },
                    if attempt.coordinator_agent.is_empty() {
                        "-"
                    } else {
                        &attempt.coordinator_agent
                    },
                    if attempt.coordinator_session_id.is_empty() {
                        "-"
                    } else {
                        &attempt.coordinator_session_id
                    }
                ),
                format!(
                    "primary session: {}  pane: {}",
                    if attempt.session_id.is_empty() {
                        "-"
                    } else {
                        &attempt.session_id
                    },
                    if attempt.pane.is_empty() {
                        "-"
                    } else {
                        &attempt.pane
                    }
                ),
                format!(
                    "babysitter: {} session={} pane={}",
                    attempt.babysitter,
                    if attempt.babysitter_session_id.is_empty() {
                        "-"
                    } else {
                        &attempt.babysitter_session_id
                    },
                    if attempt.babysitter_pane.is_empty() {
                        "-"
                    } else {
                        &attempt.babysitter_pane
                    }
                ),
            ];
            for session in &sessions {
                detail.push(format!(
                    "session {} roles={:?} api={:?}/{:?} approval={:?} input={:?}",
                    session.session_id,
                    session.roles,
                    session.api.state,
                    session.api.freshness,
                    session.api.approval_waiting,
                    session.api.input_waiting
                ));
            }
            for phase in &attempt.phases {
                detail.push(format!(
                    "phase {} ({}) state={} session={} pane={} worktree={}",
                    phase.reference,
                    phase.task_id,
                    phase.state,
                    if phase.session_id.is_empty() {
                        "-"
                    } else {
                        &phase.session_id
                    },
                    if phase.pane.is_empty() {
                        "-"
                    } else {
                        &phase.pane
                    },
                    if phase.worktree.is_empty() {
                        "-"
                    } else {
                        &phase.worktree
                    }
                ));
            }
            let worktree = snapshot
                .worktrees
                .iter()
                .find(|worktree| worktree.path == attempt.worktree)
                .map(|worktree| worktree.branch.clone())
                .unwrap_or_else(|| "-".into());
            Row {
                key: format!(
                    "attempt:{}:{}:{}",
                    attempt.task_id, attempt.workflow, attempt.attempt_id
                ),
                task_id: Some(attempt.task_id.clone()),
                kind: RowKind::Attempt,
                cells: vec![
                    attempt.task_ref.clone(),
                    attempt.workflow.clone(),
                    attempt.execution_mode.clone(),
                    attempt.state.clone(),
                    format!("{:?}", attempt.origin),
                    if attempt.session_id.is_empty() {
                        "-".into()
                    } else {
                        attempt.session_id.clone()
                    },
                    if attempt.pane.is_empty() {
                        "-".into()
                    } else {
                        attempt.pane.clone()
                    },
                ],
                state: attempt.state.clone(),
                is_epic: false,
                search: format!(
                    "{} {} {} {} {} {} {} {}",
                    attempt.task_id,
                    attempt.task_ref,
                    attempt.workflow,
                    attempt.attempt_id,
                    attempt.state,
                    attempt.session_id,
                    attempt.pane,
                    worktree
                )
                .to_lowercase(),
                detail,
            }
        })
        .collect()
}

fn session_rows(snapshot: &Snapshot) -> Vec<Row> {
    snapshot
        .sessions
        .iter()
        .map(|session| {
            let roles = session
                .roles
                .iter()
                .map(|role| format!("{role:?}").to_lowercase())
                .collect::<Vec<_>>()
                .join(",");
            let waiting = format!(
                "approval={:?} input={:?}",
                session.api.approval_waiting, session.api.input_waiting
            );
            let detail = vec![
                format!("session {}", session.session_id),
                format!("roles: {roles}"),
                format!(
                    "tasks: {}  workflows: {}  attempts: {}",
                    session.task_refs.join(","),
                    session.workflows.join(","),
                    session.attempt_ids.join(",")
                ),
                format!("pane: {}", session.pane.as_deref().unwrap_or("-")),
                format!(
                    "api state: {:?}  freshness: {:?}  observed_at_ms: {}  expires_at_ms: {}",
                    session.api.state,
                    session.api.freshness,
                    session.api.observed_at_ms,
                    session.api.expires_at_ms
                ),
                format!(
                    "waiting: {}  parent_id: {}",
                    waiting,
                    session.api.parent_id.as_deref().unwrap_or("-")
                ),
                "API activity and terminal state are separate evidence.".into(),
            ];
            Row {
                key: format!("session:{}", session.session_id),
                task_id: session.task_ids.first().cloned(),
                kind: RowKind::Session,
                cells: vec![
                    session.session_id.clone(),
                    roles,
                    session.task_refs.join(","),
                    session.workflows.join(","),
                    format!("{:?}", session.api.state),
                    waiting,
                    session.pane.clone().unwrap_or_else(|| "-".into()),
                ],
                state: format!("{:?}", session.api.state).to_lowercase(),
                is_epic: false,
                search: format!(
                    "{} {} {} {} {:?} {:?}",
                    session.session_id,
                    session.task_refs.join(" "),
                    session.workflows.join(" "),
                    session.attempt_ids.join(" "),
                    session.api.state,
                    session.api.freshness
                )
                .to_lowercase(),
                detail,
            }
        })
        .collect()
}

fn pane_rows(snapshot: &Snapshot) -> Vec<Row> {
    let mut rows = Vec::new();
    for workspace in &snapshot.workspaces {
        let detail = vec![
            format!("workspace {} ({})", workspace.workspace_id, workspace.label),
            format!(
                "repo_root: {}  checkout: {}",
                workspace.repo_root.as_deref().unwrap_or("-"),
                workspace.checkout_path.as_deref().unwrap_or("-")
            ),
            format!(
                "active_tab: {}  focused: {}",
                workspace.active_tab_id, workspace.focused
            ),
            "Herdr inherited-session topology.".into(),
        ];
        rows.push(Row {
            key: format!("workspace:{}", workspace.workspace_id),
            task_id: None,
            kind: RowKind::Workspace,
            cells: vec![
                "workspace".into(),
                workspace.workspace_id.clone(),
                workspace.label.clone(),
                workspace.active_tab_id.clone(),
                "-".into(),
                if workspace.focused {
                    "focused".into()
                } else {
                    "-".into()
                },
                workspace
                    .checkout_path
                    .clone()
                    .unwrap_or_else(|| "-".into()),
            ],
            state: if workspace.focused {
                "focused".into()
            } else {
                String::new()
            },
            is_epic: false,
            search: format!(
                "{} {} {} {}",
                workspace.workspace_id,
                workspace.label,
                workspace.repo_root.as_deref().unwrap_or(""),
                workspace.checkout_path.as_deref().unwrap_or("")
            )
            .to_lowercase(),
            detail,
        });
    }
    for pane in &snapshot.panes {
        let worktree = snapshot
            .worktrees
            .iter()
            .find(|worktree| {
                !pane.cwd.is_empty()
                    && (pane.cwd == worktree.path || pane.cwd.starts_with(&worktree.path))
            })
            .map(|worktree| format!("{} ({})", worktree.branch, worktree.path))
            .unwrap_or_else(|| "-".into());
        let detail = vec![
            format!("terminal {} in {}", pane.pane_id, pane.workspace_id),
            format!("tab: {}  cwd: {}", pane.tab_id, pane.cwd),
            format!(
                "agent profile: {}  status: {}  session: {}",
                pane.agent_profile.as_deref().unwrap_or("-"),
                pane.agent_status,
                pane.agent_session_id.as_deref().unwrap_or("-")
            ),
            format!("focused: {}", pane.focused),
            format!("worktree placement: {worktree}"),
            "Terminal observation only; not API activity.".into(),
        ];
        rows.push(Row {
            key: format!("pane:{}", pane.pane_id),
            task_id: None,
            kind: RowKind::Pane,
            cells: vec![
                "terminal".into(),
                pane.pane_id.clone(),
                pane.workspace_id.clone(),
                pane.tab_id.clone(),
                pane.agent_profile.clone().unwrap_or_else(|| "-".into()),
                pane.agent_status.clone(),
                worktree,
            ],
            state: pane.agent_status.clone(),
            is_epic: false,
            search: format!(
                "{} {} {} {} {} {}",
                pane.pane_id,
                pane.workspace_id,
                pane.tab_id,
                pane.cwd,
                pane.agent_profile.as_deref().unwrap_or(""),
                pane.agent_session_id.as_deref().unwrap_or("")
            )
            .to_lowercase(),
            detail,
        });
    }
    rows
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

pub(crate) fn help_text() -> String {
    let mut output = String::new();
    let _ = writeln!(output, "Dispatcher inspector keys");
    let _ = writeln!(output, "  j/k, arrows      move selection");
    let _ = writeln!(output, "  PgUp/PgDn Home/End page/jump");
    let _ = writeln!(
        output,
        "  /                bounded search (Enter apply, Esc cancel)"
    );
    let _ = writeln!(
        output,
        "  :                view command (overview tasks attempts sessions terminals)"
    );
    let _ = writeln!(output, "  f                cycle state filter");
    let _ = writeln!(output, "  e                toggle epic-only filter");
    let _ = writeln!(
        output,
        "  S                toggle ascending/descending sort"
    );
    let _ = writeln!(output, "  i                details for the selected row");
    let _ = writeln!(
        output,
        "  Enter            focus the exact owned pane or open a chooser"
    );
    let _ = writeln!(output, "  r                request a bounded refresh");
    let _ = writeln!(output, "  Esc              close/cancel the active surface");
    let _ = writeln!(output, "  q, Ctrl+C        quit and restore the terminal");
    let _ = writeln!(output);
    let _ = writeln!(
        output,
        "Focus revalidates the exact pane and expected session before one pane.focus request."
    );
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn snapshot() -> Snapshot {
        Snapshot {
            schema: SCHEMA.into(),
            observed_at_ms: 1,
            scope: Scope {
                project: "app".into(),
                workspace: "default".into(),
                repository: "/repo".into(),
                cwd: "/repo".into(),
                project_source: "explicit".into(),
                workspace_source: "default".into(),
                core_session: "inherited".into(),
            },
            limits: Limits::default(),
            sources: vec![SourceHealth::ok("aven", "ok")],
            tasks: vec![
                TaskRecord {
                    id: "task-one".into(),
                    reference: "APP-1".into(),
                    title: "Task \u{1b}[31mOne\u{1b}[0m 日本語".into(),
                    project: "app".into(),
                    status: "active".into(),
                    is_epic: false,
                    epic_parent: None,
                    epic_children: vec![],
                    dependencies: vec![],
                    blocks: vec![],
                    related: vec![],
                    plan: PlanMetadata::default(),
                    hydrated: true,
                    context_observed_at_ms: Some(1),
                },
                TaskRecord {
                    id: "task-two".into(),
                    reference: "APP-2".into(),
                    title: "Second".into(),
                    project: "app".into(),
                    status: "todo".into(),
                    is_epic: true,
                    epic_parent: None,
                    epic_children: vec![],
                    dependencies: vec![],
                    blocks: vec![],
                    related: vec![],
                    plan: PlanMetadata::default(),
                    hydrated: true,
                    context_observed_at_ms: Some(1),
                },
            ],
            attempts: vec![AttemptRecord {
                task_id: "task-one".into(),
                task_ref: "APP-1".into(),
                workflow: "implementation".into(),
                attempt_id: "a1".into(),
                generation: 0,
                origin: Origin::CentralStore,
                observed_at_ms: 1,
                created_at_ms: 1,
                state: "running".into(),
                execution_mode: "single-session".into(),
                backend: "hc".into(),
                core_id: "core".into(),
                terminal: TerminalLink {
                    core_id: "core".into(),
                    address: "w1:p1".into(),
                    name: "terminal".into(),
                    role: "builder".into(),
                    created_by_attempt: true,
                },
                coordinator_terminal: TerminalLink::default(),
                babysitter_terminal: TerminalLink::default(),
                branch: String::new(),
                worktree: String::new(),
                worktree_created_by_attempt: false,
                agent: String::new(),
                model: String::new(),
                coordinator_agent: String::new(),
                coordinator_model: String::new(),
                coordinator_session_id: String::new(),
                babysitter: false,
                babysitter_session_id: String::new(),
                babysitter_pane: String::new(),
                session_id: "ses_one".into(),
                pane: "w1:p1".into(),
                phases: vec![],
            }],
            sessions: vec![],
            panes: vec![PaneRecord {
                pane_id: "w1:p1".into(),
                workspace_id: "w1".into(),
                tab_id: "w1:t1".into(),
                cwd: "/repo".into(),
                agent_profile: None,
                agent_status: "idle".into(),
                agent_session_id: Some("ses_one".into()),
                focused: false,
            }],
            workspaces: vec![],
            worktrees: vec![],
            candidates: vec![PaneCandidate {
                task_id: "task-one".into(),
                task_ref: "APP-1".into(),
                workflow: "implementation".into(),
                attempt_id: "a1".into(),
                phase_task_id: None,
                role: SessionRole::Primary,
                session_id: Some("ses_one".into()),
                pane_id: "w1:p1".into(),
                core_id: "core".into(),
                labels: vec![
                    ("aven.task_id".into(), "task-one".into()),
                    ("aven.attempt_id".into(), "a1".into()),
                ],
                workspace_id: Some("w1".into()),
                tab_id: Some("w1:t1".into()),
                evidence: "persisted attempt pane".into(),
                topology_present: true,
            }],
            relationships: vec![],
            conflicts: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn navigation_search_filter_sort_and_selection_identity() {
        let snapshot = snapshot();
        let mut state = UiState::default();
        state.set_snapshot(&snapshot);
        assert_eq!(state.rows.len(), 2);
        assert_eq!(state.selected_row().unwrap().key, "task:task-one");
        state.reduce(key(KeyCode::Down), &snapshot);
        assert_eq!(state.selected_row().unwrap().key, "task:task-two");
        assert_eq!(
            state.reduce(key(KeyCode::Char('r')), &snapshot),
            Action::Refresh
        );
        state.reduce(key(KeyCode::Char(':')), &snapshot);
        for character in "attempts".chars() {
            state.reduce(key(KeyCode::Char(character)), &snapshot);
        }
        state.reduce(key(KeyCode::Enter), &snapshot);
        assert_eq!(state.view, View::Attempts);
        assert_eq!(state.rows.len(), 1);
        // The task identity does not exist in the attempt view, so selection
        // is cleared rather than silently moving to another record.
        assert!(state.selected_row().is_some());

        state.reduce(key(KeyCode::Char('/')), &snapshot);
        for character in "APP-1".chars() {
            state.reduce(key(KeyCode::Char(character)), &snapshot);
        }
        state.reduce(key(KeyCode::Enter), &snapshot);
        assert_eq!(state.search, "APP-1");
    }

    #[test]
    fn disappeared_selection_is_cleared_not_reassigned() {
        let snapshot = snapshot();
        let mut state = UiState::default();
        state.view = View::Tasks;
        state.set_snapshot(&snapshot);
        state.reduce(key(KeyCode::Down), &snapshot);
        assert_eq!(state.selected_row().unwrap().key, "task:task-two");
        let mut smaller = snapshot.clone();
        smaller.tasks.retain(|task| task.id != "task-two");
        state.set_snapshot(&smaller);
        assert!(state.selected_row().is_none());
        assert!(state.status.contains("disappeared"));
    }

    #[test]
    fn help_and_input_precedence_keep_quit_reachable() {
        let snapshot = snapshot();
        let mut state = UiState::default();
        state.set_snapshot(&snapshot);
        state.reduce(key(KeyCode::Char('?')), &snapshot);
        assert!(state.help);
        state.reduce(key(KeyCode::Char('j')), &snapshot);
        assert!(state.help, "navigation is ignored inside help");
        state.reduce(key(KeyCode::Esc), &snapshot);
        assert!(!state.help);
        state.reduce(key(KeyCode::Char('/')), &snapshot);
        state.reduce(key(KeyCode::Char('x')), &snapshot);
        assert_eq!(state.input, "x");
        assert_eq!(
            state.reduce(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                &snapshot
            ),
            Action::Quit
        );
    }

    #[test]
    fn command_allowlist_rejects_arbitrary_commands() {
        let snapshot = snapshot();
        let mut state = UiState::default();
        state.set_snapshot(&snapshot);
        state.reduce(key(KeyCode::Char(':')), &snapshot);
        for character in "shell rm -rf".chars() {
            state.reduce(key(KeyCode::Char(character)), &snapshot);
        }
        state.reduce(key(KeyCode::Enter), &snapshot);
        assert_eq!(state.view, View::Overview);
        assert!(state.status.contains("Unknown view command"));
    }

    #[test]
    fn filters_and_search_are_case_insensitive_and_bounded() {
        let snapshot = snapshot();
        let mut state = UiState::default();
        state.view = View::Tasks;
        state.set_snapshot(&snapshot);
        for character in "UPPER".chars() {
            state.input.push(character);
        }
        state.input_mode = InputMode::Search;
        state.reduce(key(KeyCode::Enter), &snapshot);
        assert_eq!(state.rows.len(), 0);
        state.search.clear();
        state.reproject_from_last();
        state.epic_only = true;
        state.reproject_from_last();
        assert_eq!(state.rows.len(), 1);
        assert!(state.rows[0].is_epic);
        state.epic_only = false;
        state.state_filter = "active".into();
        state.reproject_from_last();
        assert_eq!(state.rows.len(), 1);
        assert_eq!(state.rows[0].state, "active");
    }

    #[test]
    fn enter_resolves_one_candidate_and_opens_a_chooser_for_many() {
        let mut snapshot = snapshot();
        let mut state = UiState::default();
        state.set_snapshot(&snapshot);
        assert_eq!(state.reduce(key(KeyCode::Enter), &snapshot), Action::Focus);
        let candidate = state.take_focus_request().expect("direct candidate");
        assert_eq!(candidate.pane_id, "w1:p1");

        snapshot.candidates.push(PaneCandidate {
            pane_id: "w1:p2".into(),
            core_id: "core".into(),
            labels: vec![
                ("aven.task_id".into(), "task-one".into()),
                ("aven.attempt_id".into(), "a2".into()),
            ],
            attempt_id: "a2".into(),
            workflow: "planning".into(),
            role: SessionRole::Coordinator,
            ..snapshot.candidates[0].clone()
        });
        state.set_snapshot(&snapshot);
        assert_eq!(state.reduce(key(KeyCode::Enter), &snapshot), Action::None);
        assert!(state.chooser.is_some());
        // Chooser cancellation performs no focus request.
        state.reduce(key(KeyCode::Esc), &snapshot);
        assert!(state.chooser.is_none());
        assert!(state.take_focus_request().is_none());
        // Reopen, move to the second candidate and confirm exactly that one.
        state.reduce(key(KeyCode::Enter), &snapshot);
        state.reduce(key(KeyCode::Char('j')), &snapshot);
        assert_eq!(state.reduce(key(KeyCode::Enter), &snapshot), Action::Focus);
        let candidate = state.take_focus_request().expect("chosen candidate");
        assert_eq!(candidate.pane_id, "w1:p2");
    }

    #[test]
    fn enter_explains_zero_candidates_without_moving() {
        let mut snapshot = snapshot();
        snapshot.candidates.clear();
        let mut state = UiState::default();
        state.set_snapshot(&snapshot);
        let before = state.selected_row().unwrap().key.clone();
        assert_eq!(state.reduce(key(KeyCode::Enter), &snapshot), Action::None);
        assert!(state.status.contains("no recorded execution pane"));
        assert_eq!(state.selected_row().unwrap().key, before);
        assert!(state.take_focus_request().is_none());
    }
}
