//! Terminal and piped selection mechanics for dispatcher choices.

use anyhow::{Context, Result, bail};
use crossterm::{
    cursor,
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute, queue,
    terminal::{self, ClearType},
};
use std::{
    env, fs,
    io::{self, BufRead, IsTerminal, Write},
    path::Path,
    time::Duration,
};

use crate::{app, core, dispatch::runtime::sanitize_name, process::identifier};

/// Subsequence fuzzy match. Higher scores mean denser and earlier matches;
/// `None` means the query is not a subsequence of the candidate.
pub(crate) fn fuzzy_score(query: &str, candidate: &str) -> Option<usize> {
    let mut score = 0;
    let mut previous = None;
    let mut candidate = candidate.chars().flat_map(char::to_lowercase).enumerate();
    for query_character in query.chars().flat_map(char::to_lowercase) {
        if query_character.is_whitespace() {
            continue;
        }
        let (index, _) = candidate
            .by_ref()
            .find(|(_, candidate)| *candidate == query_character)?;
        score += match previous {
            Some(previous) if index == previous + 1 => 3,
            Some(_) => 1,
            None => 2,
        };
        previous = Some(index);
    }
    Some(score)
}

pub(crate) fn fuzzy_matches<'a>(
    choices: &'a [(String, String)],
    query: &str,
) -> Vec<&'a (String, String)> {
    let mut matches = choices
        .iter()
        .filter_map(|choice| {
            fuzzy_score(query, &format!("{} {}", choice.0, choice.1)).map(|score| (score, choice))
        })
        .collect::<Vec<_>>();
    matches.sort_by_key(|left| std::cmp::Reverse(left.0));
    matches.into_iter().map(|(_, choice)| choice).collect()
}

/// Shared terminal chooser. On a TTY the list filters live as characters are
/// typed after `/`, with arrow-key navigation; piped input keeps the numbered
/// line protocol used by tests and scripts.
pub(crate) fn choose_from(
    heading: &str,
    choices: &[(String, String)],
    input: &mut impl BufRead,
    output: &mut impl Write,
    interactive: bool,
) -> Result<Option<String>> {
    if choices.is_empty() {
        bail!("no choices are available");
    }
    if interactive {
        choose_from_interactive(heading, choices, output)
    } else {
        choose_from_lines(heading, choices, input, output)
    }
}

pub(crate) fn choose_from_lines(
    heading: &str,
    choices: &[(String, String)],
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> Result<Option<String>> {
    writeln!(output, "{heading}\n")?;
    let mut query: Option<String> = None;
    loop {
        let visible = match query.as_deref() {
            Some(query) => fuzzy_matches(choices, query),
            None => choices.iter().collect(),
        };
        for (index, (name, id)) in visible.iter().enumerate() {
            writeln!(output, "  {}. {name} ({id})", index + 1)?;
        }
        if let Some(query) = query.as_deref() {
            writeln!(
                output,
                "\n  {} of {} choices match \"{query}\".",
                visible.len(),
                choices.len()
            )?;
        }
        if visible.is_empty() {
            write!(output, "\nType / and a new query, or q to cancel: ")?;
        } else if query.is_some() {
            write!(
                output,
                "\nChoice [1-{}] of {} matching, / to search again, or q to cancel: ",
                visible.len(),
                choices.len()
            )?;
        } else {
            write!(
                output,
                "\nChoice [1-{}], / to fuzzy search, or q to cancel: ",
                visible.len()
            )?;
        }
        output.flush()?;
        let mut choice = String::new();
        if input.read_line(&mut choice)? == 0 {
            return Ok(None);
        }
        let choice = choice.trim();
        if matches!(choice, "" | "q" | "Q") {
            return Ok(None);
        }
        if let Some(search) = choice.strip_prefix('/') {
            let search = search.trim();
            query = if search.is_empty() {
                None
            } else {
                Some(search.to_lowercase())
            };
            continue;
        }
        if let Ok(index) = choice.parse::<usize>()
            && let Some(id) = index
                .checked_sub(1)
                .and_then(|index| visible.get(index))
                .map(|choice| choice.1.clone())
        {
            return Ok(Some(id));
        }
        if visible.is_empty() {
            writeln!(
                output,
                "No matches; refine the search with / or q to cancel."
            )?;
        } else {
            writeln!(output, "Enter a number from 1 to {}, or q.", visible.len())?;
        }
    }
}

/// Live-filter state. Kept separate from I/O so filtering and navigation can
/// be tested without a terminal.
#[derive(Default)]
pub(crate) struct PickerState {
    pub(crate) query: String,
    pub(crate) searching: bool,
    pub(crate) selected: usize,
}

impl PickerState {
    pub(crate) fn visible<'a>(&self, choices: &'a [(String, String)]) -> Vec<&'a (String, String)> {
        if self.query.is_empty() {
            choices.iter().collect()
        } else {
            fuzzy_matches(choices, &self.query)
        }
    }

    pub(crate) fn clamp(&mut self, count: usize) {
        self.selected = self.selected.min(count.saturating_sub(1));
    }

    pub(crate) fn down(&mut self, count: usize) {
        if count == 0 {
            self.selected = 0;
        } else {
            self.selected = (self.selected + 1) % count;
        }
    }

    pub(crate) fn up(&mut self, count: usize) {
        if count == 0 {
            self.selected = 0;
        } else if self.selected == 0 {
            self.selected = count - 1;
        } else {
            self.selected -= 1;
        }
    }

    pub(crate) fn type_character(&mut self, character: char) {
        self.query.push(character);
        self.selected = 0;
    }

    pub(crate) fn backspace(&mut self) {
        self.query.pop();
        self.selected = 0;
    }
}

/// Restores canonical input and echoing even when the picker exits early.
struct RawMode;
impl RawMode {
    fn enter() -> io::Result<Self> {
        terminal::enable_raw_mode()?;
        Ok(Self)
    }
}
impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
    }
}

pub(crate) fn choose_from_interactive(
    heading: &str,
    choices: &[(String, String)],
    output: &mut impl Write,
) -> Result<Option<String>> {
    let raw = RawMode::enter().context("enable interactive picker input")?;
    execute!(output, terminal::EnterAlternateScreen, cursor::Hide)
        .context("enter picker screen")?;
    let result = interactive_pick_loop(heading, choices, output);
    let restored = execute!(output, cursor::Show, terminal::LeaveAlternateScreen)
        .context("leave picker screen");
    drop(raw);
    match result {
        Ok(selection) => {
            restored?;
            Ok(selection)
        }
        Err(error) => {
            let _ = restored;
            Err(error)
        }
    }
}

fn interactive_pick_loop(
    heading: &str,
    choices: &[(String, String)],
    output: &mut impl Write,
) -> Result<Option<String>> {
    let mut state = PickerState::default();
    loop {
        let visible = state.visible(choices);
        state.clamp(visible.len());
        render_picker(output, heading, choices.len(), &visible, &state)?;
        let Event::Key(key) = event::read().context("read picker input")? else {
            continue;
        };
        if key.kind == KeyEventKind::Release {
            continue;
        }
        match key.code {
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => return Ok(None),
            KeyCode::Esc => {
                if state.query.is_empty() {
                    return Ok(None);
                }
                state.query.clear();
                state.searching = false;
                state.selected = 0;
            }
            KeyCode::Enter => {
                if let Some(choice) = visible.get(state.selected) {
                    return Ok(Some(choice.1.clone()));
                }
            }
            KeyCode::Up => state.up(visible.len()),
            KeyCode::Down => state.down(visible.len()),
            KeyCode::PageUp => state.selected = state.selected.saturating_sub(10),
            KeyCode::PageDown => {
                state.selected = (state.selected + 10).min(visible.len().saturating_sub(1));
            }
            KeyCode::Home => state.selected = 0,
            KeyCode::End => state.selected = visible.len().saturating_sub(1),
            KeyCode::Backspace if state.searching => state.backspace(),
            KeyCode::Char('/') if !state.searching => {
                state.searching = true;
                state.query.clear();
                state.selected = 0;
            }
            KeyCode::Char(character)
                if state.searching
                    && !key
                        .modifiers
                        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                state.type_character(character);
            }
            KeyCode::Char('q') if !state.searching => return Ok(None),
            _ => {}
        }
    }
}

pub(crate) fn truncate_chars(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        return value.to_owned();
    }
    value
        .chars()
        .take(width.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn render_picker(
    output: &mut impl Write,
    heading: &str,
    total: usize,
    visible: &[&(String, String)],
    state: &PickerState,
) -> Result<()> {
    let (columns, rows) = match terminal::size() {
        Ok((columns, rows)) if columns > 0 && rows > 0 => (columns, rows),
        _ => (80, 24),
    };
    let width = usize::from(columns.max(20));
    let capacity = usize::from(rows).saturating_sub(6).max(1);
    let start = if visible.len() <= capacity {
        0
    } else {
        state
            .selected
            .saturating_sub(capacity / 2)
            .min(visible.len() - capacity)
    };
    let end = (start + capacity).min(visible.len());
    queue!(
        output,
        terminal::Clear(ClearType::All),
        cursor::MoveTo(0, 0)
    )?;
    writeln!(output, "{heading}\r")?;
    if state.searching {
        writeln!(output, "  fuzzy: /{}\r", state.query)?;
    } else {
        writeln!(output, "  press / to fuzzy search\r")?;
    }
    writeln!(output, "  {} of {} choices\r", visible.len(), total)?;
    if visible.is_empty() {
        writeln!(output, "  no matches\r")?;
    }
    for (offset, (name, id)) in visible[start..end].iter().enumerate() {
        let index = start + offset;
        let line = truncate_chars(
            &format!("{:>3}. {name} ({id})", index + 1),
            width.saturating_sub(4),
        );
        if index == state.selected {
            writeln!(output, "  \x1b[7m{line}\x1b[0m\r")?;
        } else {
            writeln!(output, "  {line}\r")?;
        }
    }
    writeln!(
        output,
        "\r  Up/Down move · Enter select · / search · Esc clear/cancel\r"
    )?;
    output.flush()?;
    Ok(())
}

pub(crate) fn spawn_picker(
    kind: &str,
    choices: &[(String, String)],
    store_path: &Path,
) -> Result<String> {
    if choices.is_empty() {
        bail!("no {kind} choices are available");
    }
    let ids = choices
        .iter()
        .map(|(_, id)| id.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let names = choices
        .iter()
        .map(|(name, _)| name.replace(['\n', '\r'], " "))
        .collect::<Vec<_>>()
        .join("\n");
    let id = identifier("pick");
    let response = store_path.with_file_name(format!(".picker-{kind}-{id}.response"));
    let _ = fs::remove_file(&response);
    let response_text = response
        .to_str()
        .context("picker response path is not valid UTF-8")?
        .to_owned();
    let suffix = id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .rev()
        .take(6)
        .collect::<String>();
    let name = format!("aven-pick-{}-{suffix}", sanitize_name(kind));
    let executable = env::current_exe().context("resolve aven-dispatch executable")?;
    let terminal = core::launch(&core::LaunchSpec {
        name,
        cwd: env::current_dir()?.to_string_lossy().to_string(),
        labels: vec![
            ("aven.dispatch".into(), "1".into()),
            ("aven.role".into(), "picker".into()),
            ("aven.picker".into(), kind.into()),
        ],
        env: vec![
            (
                "AVEN_DISPATCH_PICKER_RESPONSE".into(),
                response_text.clone(),
            ),
            ("AVEN_DISPATCH_PICKER_NAMES".into(), names),
            ("AVEN_DISPATCH_PICKER_IDS".into(), ids),
        ],
        argv: vec![
            executable.to_string_lossy().to_string(),
            "pick".into(),
            "--kind".into(),
            kind.into(),
        ],
    })?;
    // Revealing the picker is optional; submission waits for its response file.
    let _ = app::peek(&terminal.address);
    // Interactive search can legitimately take a while; liveness is still
    // checked below, so this is only a backstop against a wedged terminal.
    for tick in 0..18000u32 {
        if response.exists() {
            let selected = fs::read_to_string(&response)?.trim().to_owned();
            let _ = fs::remove_file(&response);
            if choices.iter().any(|(_, id)| id == &selected) {
                let _ = core::remove(&terminal.address);
                return Ok(selected);
            }
            bail!("OpenCode {kind} selection was canceled");
        }
        if tick % 10 == 9
            && let Ok(current) = core::get(&terminal.address)
            && !current.live()
        {
            bail!("OpenCode {kind} picker exited without a selection");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = core::kill(&terminal.address);
    let _ = core::remove(&terminal.address);
    bail!("timed out waiting for the herdr-core OpenCode {kind} picker")
}

/// Persist a picker result for the Aven command integration.
pub(crate) fn pick(kind: &str) -> Result<()> {
    let response = env::var("AVEN_DISPATCH_PICKER_RESPONSE")
        .context("AVEN_DISPATCH_PICKER_RESPONSE is not set")?;
    let names =
        env::var("AVEN_DISPATCH_PICKER_NAMES").context("AVEN_DISPATCH_PICKER_NAMES is not set")?;
    let ids =
        env::var("AVEN_DISPATCH_PICKER_IDS").context("AVEN_DISPATCH_PICKER_IDS is not set")?;
    let heading = match kind {
        "agent" => "Select an OpenCode agent:",
        "model" => "Select an OpenCode model:",
        other => bail!("unknown picker kind: {other}"),
    };
    let choices = names
        .lines()
        .zip(ids.lines())
        .map(|(name, id)| (name.to_owned(), id.to_owned()))
        .collect::<Vec<_>>();
    let selected = if choices.is_empty() {
        "cancelled".to_owned()
    } else {
        choose_from(
            heading,
            &choices,
            &mut io::stdin().lock(),
            &mut io::stdout().lock(),
            io::stdin().is_terminal() && io::stdout().is_terminal(),
        )?
        .unwrap_or_else(|| "cancelled".into())
    };
    let temporary = format!("{response}.new");
    fs::write(&temporary, format!("{selected}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&temporary, &response)?;
    Ok(())
}
