import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, focused, hc, props, run, spaces, terminals, theme } from "herdr";
import { LIMIT, canonicalId, launchArgs, mergeCoverage, mergeProjectRows, openArgs, projectArgs, resolveSpaceContext, terminalIdentity, terminalName, upcomingArgs, isLiveEpicTerminal } from "./logic.js";

const REFRESH_MS = 10000;
const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 50;

function parse(result, label) {
  if (result.code !== 0) throw new Error(`${label}: ${(result.stderr || "").trim() || `exit ${result.code}`}`);
  const parsed = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error(`${label}: expected a JSON list`);
  return parsed;
}

export default class AvenPanel extends View {
  init(_props, cx) {
    this.state = { loading: true, rows: [], coverageError: "", error: "", stale: false };
    this.refreshing = false;
    this.closed = false;
    this.pendingLaunches = new Set();
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (timerCx) => this.refresh(timerCx));
  }

  async close() { this.closed = true; }

  workspace() { return String(props()?.workspace ?? "default"); }
  cwd() { return String(props()?.cwd ?? ""); }
  space() { const id = focused()?.space; return spaces().find((space) => space.id === id) ?? spaces().find((space) => space.active) ?? null; }

  notify(cx) { if (!this.closed) { try { cx.notify(); } catch {} } }

  refresh(cx) {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    this.state = { ...this.state, loading: !this.state.rows.length, error: "" };
    this.notify(cx);
    cx.spawn(async (taskCx) => {
      try {
        const workspace = this.workspace();
        const projects = parse(await exec("aven", projectArgs(workspace)), "Aven projects");
        if (projects.length >= LIMIT) throw new Error(`project list reached the ${LIMIT}-project safety limit`);
        const results = [];
        for (const project of projects) {
          const key = String(project.key ?? "");
          if (!key) { results.push({ project: "unknown", error: "malformed project" }); continue; }
          try {
            const [open, upcoming] = await Promise.all([
              exec("aven", openArgs(workspace, key)), exec("aven", upcomingArgs(workspace, key)),
            ]);
            const openRows = parse(open, `${key} open epics`);
            const upcomingRows = parse(upcoming, `${key} upcoming epics`);
            if (openRows.length >= LIMIT || upcomingRows.length >= LIMIT) throw new Error(`read reached the ${LIMIT}-item safety limit`);
            results.push({ project: key, rows: mergeProjectRows({ workspace, project: key, open: openRows, upcoming: upcomingRows }) });
          } catch (error) { results.push({ project: key, error: String(error?.message ?? error) }); }
        }
        const merged = mergeCoverage(results);
        const space = this.space();
        let context;
        try {
          const attempts = JSON.parse((await exec("aven-dispatch", ["list"], space?.folder ? { cwd: space.folder } : undefined)).stdout || "[]");
          const match = attempts.filter((attempt) => String(attempt?.worktree ?? "") === String(space?.folder ?? ""));
          let task, root;
          if (match.length === 1 && match[0].task_ref) {
            task = JSON.parse((await exec("aven", ["show", match[0].task_ref, "--json"], space?.folder ? { cwd: space.folder } : undefined)).stdout);
            root = task.is_epic ? task : task.epic_parent?.ref ? JSON.parse((await exec("aven", ["show", task.epic_parent.ref, "--json"], space?.folder ? { cwd: space.folder } : undefined)).stdout) : null;
          }
          context = resolveSpaceContext({ space, attempts, task, root, rows: merged.rows });
        } catch { context = { kind: "unavailable", name: String(space?.name ?? ""), folder: String(space?.folder ?? ""), message: "Dispatcher context is unavailable." }; }
        this.state = { loading: false, rows: merged.rows, context, coverageError: merged.coverageError, error: "", stale: Boolean(merged.coverageError) };
      } catch (error) {
        const message = String(error?.message ?? error);
        this.state = { ...this.state, loading: false, error: message, stale: this.state.rows.length > 0 };
      } finally {
        this.refreshing = false;
        this.notify(taskCx);
      }
    });
  }

  async reveal(address, cx) {
    if (!address) return;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const result = await exec("herdr-app", ["do", "terminal.peek", "--terminal", address]);
        if (result.code === 0) { run("terminal.peek", { terminal: address }); return; }
      } catch { break; }
      await cx.sleep(READY_POLL_MS);
    }
    run("terminal.peek", { terminal: address });
  }

  launch(epic, cx) {
    const workspace = this.workspace(), identity = terminalIdentity(workspace, epic.id);
    if (this.pendingLaunches.has(identity)) return;
    const existing = terminals().find((terminal) => isLiveEpicTerminal(terminal, workspace, epic.id));
    if (existing) { void this.reveal(existing.address, cx); return; }
    this.pendingLaunches.add(identity);
    cx.spawn(async (taskCx) => {
      try {
        const name = `${terminalName(workspace, epic.id)}${Date.now().toString(36)}`;
        const result = await hc(launchArgs({ workspace, epic, cwd: this.cwd(), name }));
        if (result.code !== 0) throw new Error((result.stderr || "").trim() || "could not start Aven");
        await this.reveal(JSON.parse(result.stdout).address, taskCx);
      } catch (error) {
        this.state = { ...this.state, error: String(error?.message ?? error) };
      } finally {
        this.pendingLaunches.delete(identity);
        this.notify(taskCx);
      }
    });
  }

  row(t, epic, cx) {
    const pinned = canonicalId(this.state.context?.pinned) === canonicalId(epic);
    return v_flex().id(`aven-epic-${epic.id}`).mx(8).px(9).py(7).gap(3).rounded(6).cursor_pointer().when(pinned, (el) => el.bg(t.selected))
      .hover((style) => style.bg(t.hover)).on_click((_event, clickCx) => this.launch(epic, clickCx ?? cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(epic.title))
        .child(div().flex_none().text_size(10).text_color(t.accent).child(epic.status)))
      .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
        .child(div().flex_none().child(epic.ref)).child(div().min_w(0).truncate().child(epic.project)));
  }

  render(cx) {
    const t = theme(), state = this.state;
    return v_flex().id("aven-panel").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_size_change((size, sizeCx) => { this.size = size; this.notify(sizeCx); })
      .child(h_flex().h(38).px(11).gap(7).items_center().flex_none()
        .child(div().flex_1().text_size(12).font_semibold().child("Aven epics"))
        .child(div().id("aven-panel-refresh").px(7).py(4).rounded(5).cursor_pointer().text_size(11).text_color(t.muted)
          .hover((style) => style.bg(t.hover).text_color(t.foreground)).on_click((_event, clickCx) => this.refresh(clickCx)).child("Refresh")))
      .child(div().h(1).flex_none().bg(t.border))
      .when(Boolean(state.context), (el) => el.child(v_flex().mx(8).my(7).p(8).gap(2).rounded(6).bg(t.raised)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child("CURRENT SPACE"))
        .child(div().text_size(11.5).truncate().child(state.context.name || "Unnamed space"))
        .when(Boolean(state.context.folder), (row) => row.child(div().text_size(10.5).truncate().text_color(t.dim).child(state.context.folder)))
        .child(div().text_size(10.5).text_color(t.muted).child(state.context.message))
        .when(state.context.kind === "dispatch", (row) => row.child(h_flex().gap(6).items_center().child(div().flex_1().min_w(0).truncate().text_size(10.5).child(`${state.context.root.ref} · ${state.context.root.title}`)).child(div().id("aven-panel-open-root").px(6).py(3).rounded(4).cursor_pointer().text_size(10.5).bg(t.selected).on_click((_event, clickCx) => this.launch(state.context.root, clickCx)).child("Open root"))))))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().py(5)
        .when(state.loading, (el) => el.child(div().p(12).text_size(11.5).text_color(t.dim).child("Loading epics…")))
        .when(Boolean(state.error), (el) => el.child(div().mx(8).p(8).rounded(6).text_size(11).text_color(t.blocked).bg(t.raised).child(state.error)))
        .when(Boolean(state.coverageError), (el) => el.child(div().mx(8).p(8).rounded(6).text_size(11).text_color(t.blocked).bg(t.raised).child(`Incomplete coverage: ${state.coverageError}`)))
        .when(state.stale && state.rows.length > 0, (el) => el.child(div().mx(8).py(5).text_size(10.5).text_color(t.dim).child("Showing last successful results (stale).")))
        .when(!state.loading && !state.error && !state.coverageError && state.rows.length === 0, (el) => el.child(div().p(12).text_size(11.5).text_color(t.dim).child("No open epics in this workspace.")))
        .children(state.rows.map((epic) => this.row(t, epic, cx))));
  }
}
