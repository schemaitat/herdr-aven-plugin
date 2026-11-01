//! Ratatui rendering for the read-only inspector.

use ratatui::{
    Frame,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Cell, Clear, Paragraph, Row as TableRow, Table, Wrap},
};

use super::state::{UiState, View, help_text};
use crate::inspect::model::{HealthStatus, Snapshot};

pub(crate) fn draw(frame: &mut Frame<'_>, state: &mut UiState, snapshot: &Snapshot) {
    let area = frame.area();
    if area.width == 0 || area.height == 0 {
        return;
    }
    let header_height = if area.height >= 12 {
        3
    } else if area.height >= 8 {
        2
    } else {
        1
    };
    let footer_height = u16::from(area.height >= 6);
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(header_height),
            Constraint::Min(1),
            Constraint::Length(footer_height),
        ])
        .split(area);

    draw_header(frame, chunks[0], state, snapshot);
    if state.help {
        draw_table(frame, chunks[1], state);
        draw_help(frame, chunks[1]);
    } else if state.chooser.is_some() {
        draw_table(frame, chunks[1], state);
        draw_chooser(frame, chunks[1], state);
    } else if state.details {
        if chunks[1].height >= 16 && chunks[1].width >= 70 {
            let split = Layout::default()
                .direction(Direction::Vertical)
                .constraints([Constraint::Percentage(45), Constraint::Percentage(55)])
                .split(chunks[1]);
            draw_table(frame, split[0], state);
            draw_details(frame, split[1], state);
        } else {
            draw_table(frame, chunks[1], state);
            draw_details(frame, chunks[1], state);
        }
    } else {
        draw_table(frame, chunks[1], state);
    }
    draw_footer(frame, chunks[2], state);
}

fn draw_header(frame: &mut Frame<'_>, area: Rect, state: &UiState, snapshot: &Snapshot) {
    let health = snapshot
        .sources
        .iter()
        .map(|source| {
            let status = match source.status {
                HealthStatus::Ok => "ok",
                HealthStatus::Incomplete => "incomplete",
                HealthStatus::Unavailable => "unavailable",
                HealthStatus::Stale => "stale",
            };
            Span::styled(
                format!("{}:{}", source.source, status),
                health_style(source.status),
            )
        })
        .collect::<Vec<_>>();
    let mut first = vec![
        Span::styled(
            format!(
                " {} / {} ",
                snapshot.scope.project, snapshot.scope.workspace
            ),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!("repo {} ", snapshot.scope.repository)),
    ];
    if area.height >= 2 {
        first.push(Span::raw(format!("core:{} ", snapshot.scope.core_session)));
    }
    let filters = format!(
        "view:{}  filter:{}  epic:{}  search:{}  sort:{}",
        state.view.label(),
        if state.state_filter.is_empty() {
            "-"
        } else {
            &state.state_filter
        },
        if state.epic_only { "on" } else { "off" },
        if state.search.is_empty() {
            "-"
        } else {
            &state.search
        },
        if state.sort_descending { "desc" } else { "asc" }
    );
    let counts = format!(
        "tasks {}  attempts {}  sessions {}  panes {}  workspaces {}  conflicts {}",
        snapshot.tasks.len(),
        snapshot.attempts.len(),
        snapshot.sessions.len(),
        snapshot.panes.len(),
        snapshot.workspaces.len(),
        snapshot.conflicts.len()
    );
    let mut lines = vec![Line::from(first), Line::from(health)];
    if area.height >= 3 {
        lines.push(Line::from(vec![
            Span::raw(counts),
            Span::raw("  "),
            Span::styled(filters, Style::default().fg(Color::DarkGray)),
        ]));
    }
    frame.render_widget(
        Paragraph::new(Text::from(lines)).block(Block::default().borders(Borders::BOTTOM)),
        area,
    );
}

fn draw_table(frame: &mut Frame<'_>, area: Rect, state: &mut UiState) {
    if state.rows.is_empty() {
        frame.render_widget(
            Paragraph::new(format!(
                "No {} records match the current scope/filters.\nPress r to refresh, / to search, or ? for help.",
                state.view.label()
            ))
            .block(Block::default().borders(Borders::ALL).title(" inspector "))
            .wrap(Wrap { trim: true }),
            area,
        );
        return;
    }
    let headers = visible_headers(state.view, area.width);
    let columns = headers.len();
    let header = TableRow::new(
        headers
            .iter()
            .map(|header| Cell::from((*header).to_owned()))
            .collect::<Vec<_>>(),
    )
    .style(Style::default().add_modifier(Modifier::BOLD));
    let rows = state
        .rows
        .iter()
        .map(|row| {
            let cells = row
                .cells
                .iter()
                .take(columns)
                .map(|cell| Cell::from(cell.clone()))
                .collect::<Vec<_>>();
            TableRow::new(cells).style(status_style(&row.state))
        })
        .collect::<Vec<_>>();
    let widths = headers
        .iter()
        .enumerate()
        .map(|(index, header)| {
            if index == 1 {
                Constraint::Min(12)
            } else {
                Constraint::Length((header.chars().count() as u16 + 5).min(24))
            }
        })
        .collect::<Vec<_>>();
    let table = Table::new(rows, widths)
        .header(header)
        .block(Block::default().borders(Borders::ALL).title(format!(
            " {} {} ",
            state.view.label(),
            if state.rows.len() == 1 {
                "1 record".to_owned()
            } else {
                format!("{} records", state.rows.len())
            }
        )))
        .column_spacing(1)
        .highlight_symbol("› ")
        .row_highlight_style(Style::default().add_modifier(Modifier::REVERSED));
    frame.render_stateful_widget(table, area, &mut state.table);
}

fn visible_headers(view: View, width: u16) -> Vec<&'static str> {
    let headers = view.headers();
    if width >= 100 {
        headers
    } else if width >= 70 {
        let keep = if headers.len() > 5 { 5 } else { headers.len() };
        headers.into_iter().take(keep).collect()
    } else {
        headers.into_iter().take(3).collect()
    }
}

fn draw_details(frame: &mut Frame<'_>, area: Rect, state: &UiState) {
    let Some(row) = state.selected_row() else {
        return;
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .title(format!(" details · {:?} ", row.kind));
    let inner = block.inner(area);
    frame.render_widget(Clear, area);
    frame.render_widget(block, area);
    let lines = row
        .detail
        .iter()
        .map(|line| Line::from(line.clone()))
        .collect::<Vec<_>>();
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .wrap(Wrap { trim: false })
            .scroll((0, 0)),
        inner,
    );
}

fn draw_chooser(frame: &mut Frame<'_>, area: Rect, state: &UiState) {
    let Some(chooser) = &state.chooser else {
        return;
    };
    let popup = centered(area, 90, 75);
    frame.render_widget(Clear, popup);
    let mut lines = Vec::new();
    for (index, candidate) in chooser.candidates.iter().enumerate() {
        let marker = if index == chooser.index { "› " } else { "  " };
        let style = if index == chooser.index {
            Style::default().add_modifier(Modifier::REVERSED)
        } else {
            Style::default()
        };
        lines.push(Line::from(Span::styled(
            format!("{marker}{}. {}", index + 1, candidate.label()),
            style,
        )));
        lines.push(Line::from(Span::styled(
            format!("    evidence: {}", candidate.evidence),
            Style::default().fg(Color::DarkGray),
        )));
    }
    lines.push(Line::from(
        "j/k selects · Enter focuses exact pane · Esc/q cancels with no focus call",
    ));
    frame.render_widget(
        Paragraph::new(Text::from(lines))
            .block(Block::default().borders(Borders::ALL).title(format!(
                " choose pane · {} candidate(s) · no automatic fallback ",
                chooser.candidates.len()
            )))
            .wrap(Wrap { trim: true }),
        popup,
    );
}

fn draw_help(frame: &mut Frame<'_>, area: Rect) {
    let popup = centered(area, 76, 82);
    frame.render_widget(Clear, popup);
    frame.render_widget(
        Paragraph::new(help_text())
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" help · Esc/?/q closes "),
            )
            .wrap(Wrap { trim: false }),
        popup,
    );
}

fn draw_footer(frame: &mut Frame<'_>, area: Rect, state: &UiState) {
    if area.height == 0 {
        return;
    }
    let message = if !state.status.is_empty() {
        state.status.clone()
    } else if state.input_mode != super::state::InputMode::None {
        format!(
            "{}: {}_",
            if state.input_mode == super::state::InputMode::Search {
                "search"
            } else {
                "view"
            },
            state.input
        )
    } else if state.details {
        if area.width < 70 {
            "details · Esc close · q quit".into()
        } else {
            "details · Esc/i closes · j/k moves · ? help · q quit".into()
        }
    } else if area.width < 70 {
        "? help  / search  q quit".into()
    } else {
        "? help  / search  : view  f filter  e epic  S sort  i details  r refresh  q quit".into()
    };
    frame.render_widget(
        Paragraph::new(message)
            .style(Style::default().fg(Color::DarkGray))
            .alignment(Alignment::Left),
        area,
    );
}

fn status_style(state: &str) -> Style {
    match state {
        "active" | "running" | "working" | "focused" => Style::default().fg(Color::Green),
        "todo" | "starting" | "idle" => Style::default().fg(Color::Cyan),
        "waiting" | "needs-review" => Style::default().fg(Color::Yellow),
        "done" => Style::default().fg(Color::Gray),
        "failed" | "interrupted" | "missing" | "unknown" => Style::default().fg(Color::Red),
        _ => Style::default(),
    }
}

fn health_style(status: HealthStatus) -> Style {
    match status {
        HealthStatus::Ok => Style::default().fg(Color::Green),
        HealthStatus::Incomplete => Style::default().fg(Color::Yellow),
        HealthStatus::Unavailable | HealthStatus::Stale => Style::default().fg(Color::Red),
    }
}

fn centered(area: Rect, percent_x: u16, percent_y: u16) -> Rect {
    let vertical = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - percent_y) / 2),
            Constraint::Percentage(percent_y),
            Constraint::Percentage((100 - percent_y) / 2),
        ])
        .split(area);
    let horizontal = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - percent_x) / 2),
            Constraint::Percentage(percent_x),
            Constraint::Percentage((100 - percent_x) / 2),
        ])
        .split(vertical[1]);
    horizontal[1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inspect::model::*;
    use crate::tui::state::{Action, UiState, View};
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::{Terminal, backend::TestBackend};

    fn fixture() -> Snapshot {
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
            sources: vec![
                SourceHealth::ok("aven", "ok"),
                SourceHealth::unavailable("herdr", "not inside Herdr"),
            ],
            tasks: vec![TaskRecord {
                id: "task-one".into(),
                reference: "APP-1".into(),
                title: "日本語 task with a long title \u{1b}[31m红色\u{1b}[0m".into(),
                project: "app".into(),
                status: "active".into(),
                is_epic: false,
                epic_parent: None,
                epic_children: vec![],
                dependencies: vec![BoundaryRef {
                    kind: "dependency".into(),
                    id: "dep-one".into(),
                    reference: Some("APP-DEP".into()),
                    title: Some("dependency".into()),
                    status: Some("todo".into()),
                    hydrated: false,
                }],
                blocks: vec![],
                related: vec![],
                plan: PlanMetadata {
                    plan_root: Some("APP-9".into()),
                    plan_phase: Some("01".into()),
                    plan_kind: Some("multi-phase".into()),
                    plan_worked_out: true,
                    reset_generation: 2,
                    reset_state: Some("completed".into()),
                },
                hydrated: true,
                context_observed_at_ms: Some(1),
            }],
            attempts: vec![AttemptRecord {
                task_id: "task-one".into(),
                task_ref: "APP-1".into(),
                workflow: "implementation".into(),
                attempt_id: "a1".into(),
                generation: 2,
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
                branch: "app/dispatch-task-one".into(),
                worktree: "/repo/wt".into(),
                worktree_created_by_attempt: true,
                agent: "build".into(),
                model: "provider/model".into(),
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
            sessions: vec![SessionRecord {
                session_id: "ses_one".into(),
                roles: vec![SessionRole::Primary],
                task_ids: vec!["task-one".into()],
                task_refs: vec!["APP-1".into()],
                workflows: vec!["implementation".into()],
                attempt_ids: vec!["a1".into()],
                pane: Some("w1:p1".into()),
                api: ApiActivity {
                    state: ApiState::Working,
                    freshness: Freshness::Current,
                    observed_at_ms: 1,
                    expires_at_ms: 4_501,
                    approval_waiting: Tri::No,
                    input_waiting: Tri::No,
                    parent_id: None,
                },
            }],
            panes: vec![PaneRecord {
                pane_id: "w1:p1".into(),
                workspace_id: "w1".into(),
                tab_id: "w1:t1".into(),
                cwd: "/repo/wt".into(),
                agent_profile: Some("opencode".into()),
                agent_status: "idle".into(),
                agent_session_id: Some("ses_one".into()),
                focused: true,
            }],
            workspaces: vec![WorkspaceRecord {
                workspace_id: "w1".into(),
                label: "app".into(),
                repo_root: Some("/repo".into()),
                checkout_path: Some("/repo/wt".into()),
                active_tab_id: "w1:t1".into(),
                focused: true,
            }],
            worktrees: vec![WorktreeRecord {
                path: "/repo/wt".into(),
                branch: "app/dispatch-task-one".into(),
                open_workspace_id: Some("w1".into()),
                origin: WorktreeOrigin::Core,
            }],
            candidates: vec![],
            relationships: vec![],
            conflicts: vec![],
            warnings: vec![],
        }
    }

    fn render(state: &mut UiState, snapshot: &Snapshot, width: u16, height: u16) -> String {
        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, state, snapshot)).unwrap();
        let buffer = terminal.backend().buffer();
        let mut output = String::new();
        for y in 0..height {
            for x in 0..width {
                output.push_str(buffer.cell((x, y)).map(|cell| cell.symbol()).unwrap_or(" "));
            }
            output.push('\n');
        }
        output
    }

    #[test]
    fn all_views_render_at_standard_and_compact_sizes() {
        let snapshot = fixture();
        for view in [
            View::Overview,
            View::Tasks,
            View::Attempts,
            View::Sessions,
            View::Panes,
        ] {
            let mut state = UiState::default();
            state.view = view;
            state.set_snapshot(&snapshot);
            for (width, height) in [(80, 24), (40, 10), (120, 30), (20, 5)] {
                let output = render(&mut state, &snapshot, width, height);
                assert!(!output.is_empty());
            }
        }
    }

    #[test]
    fn five_hundred_task_fixture_meets_reducer_filter_render_budget() {
        let mut snapshot = fixture();
        snapshot.tasks = (0..500)
            .map(|index| {
                let mut task = snapshot.tasks[0].clone();
                task.id = format!("task-{index:03}");
                task.reference = format!("APP-{index:03}");
                task.title = format!("synthetic task {index} with a representative title");
                task.status = if index % 2 == 0 { "active" } else { "todo" }.into();
                task
            })
            .collect();
        snapshot.attempts = (0..500)
            .map(|index| {
                let mut attempt = snapshot.attempts[0].clone();
                attempt.task_id = format!("task-{index:03}");
                attempt.task_ref = format!("APP-{index:03}");
                attempt.attempt_id = format!("a{index:03}");
                attempt.pane = format!("w1:p{}", index + 1);
                attempt
            })
            .collect();
        let mut state = UiState::default();
        state.view = View::Tasks;
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut samples = Vec::new();
        for iteration in 0..200 {
            state.search = if iteration % 2 == 0 {
                "synthetic".into()
            } else {
                String::new()
            };
            state.state_filter = if iteration % 3 == 0 {
                "active".into()
            } else {
                String::new()
            };
            let started = std::time::Instant::now();
            state.set_snapshot(&snapshot);
            terminal
                .draw(|frame| draw(frame, &mut state, &snapshot))
                .unwrap();
            samples.push(started.elapsed());
        }
        samples.sort();
        let p95 = samples[samples.len() * 95 / 100];
        eprintln!("500-task reducer/filter/render p95={p95:?}");
        assert!(
            p95 <= std::time::Duration::from_millis(50),
            "500-task p95 {p95:?} exceeds 50 ms"
        );
    }

    #[test]
    fn details_and_help_are_reachable_and_closable() {
        let snapshot = fixture();
        let mut state = UiState::default();
        state.view = View::Tasks;
        state.set_snapshot(&snapshot);
        state.details = true;
        let output = render(&mut state, &snapshot, 80, 24);
        assert!(output.contains("details"));
        state.details = false;
        state.help = true;
        let output = render(&mut state, &snapshot, 80, 24);
        assert!(output.contains("Dispatcher inspector keys"));
        assert!(help_text().contains("revalidates the exact pane"));
    }

    #[test]
    fn empty_and_resized_snapshots_do_not_panic_and_keep_quit_visible() {
        let mut snapshot = fixture();
        snapshot.tasks.clear();
        snapshot.attempts.clear();
        snapshot.sessions.clear();
        snapshot.panes.clear();
        snapshot.workspaces.clear();
        let mut state = UiState::default();
        state.view = View::Tasks;
        state.set_snapshot(&snapshot);
        let output = render(&mut state, &snapshot, 40, 10);
        assert!(output.contains("No tasks records"));
        assert!(output.contains("q quit"));
        let output = render(&mut state, &snapshot, 10, 3);
        assert!(!output.is_empty());
        assert_eq!(
            state.reduce(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                &snapshot
            ),
            Action::Quit
        );
    }
}
