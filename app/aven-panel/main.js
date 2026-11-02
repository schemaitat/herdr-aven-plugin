import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, focused, hc, props, run, spaces, terminals, theme } from "herdr";
import { DISPATCH_ACTIONS, LIMIT, canonicalId, inferredEpicArgs, inferredUpcomingArgs, launchArgs, mergeProjectRows, resolveSpaceContext, scopeEpics, terminalIdentity, terminalName, isLiveEpicTerminal } from "./logic.js";

const REFRESH_MS = 10000;
const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 50;
const READY_SETTLE_MS = 700;

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
    this.scope = "all";
    this.dispatchMenuEpicId = null;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (timerCx) => this.refresh(timerCx));
  }

  async close() { this.closed = true; }

  workspace() { return String(props()?.workspace ?? "default"); }
  cwd() { return String(props()?.cwd ?? ""); }
  space() { const id = focused()?.space; return spaces().find((space) => space.id === id) ?? spaces().find((space) => space.active) ?? null; }

  async rootFolder(folder) {
    if (!folder) return undefined;
    try {
      const result = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder });
      const common = result.code === 0 ? result.stdout.trim().replace(/\/+$/, "") : "";
      return common.endsWith("/.git") ? common.slice(0, -5) : folder;
    } catch { return folder; }
  }

  notify(cx) { if (!this.closed) { try { cx.notify(); } catch {} } }

  refresh(cx) {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    this.state = { ...this.state, loading: !this.state.rows.length, error: "" };
    this.notify(cx);
    cx.spawn(async (taskCx) => {
      try {
        const workspace = this.workspace();
        const space = this.space();
        const cwd = await this.rootFolder(space?.folder || this.cwd());
        const [open, upcoming] = await Promise.all([
          exec("aven", inferredEpicArgs(workspace), cwd ? { cwd } : undefined),
          exec("aven", inferredUpcomingArgs(workspace), cwd ? { cwd } : undefined),
        ]);
        const openRows = parse(open, "Open epics"), upcomingRows = parse(upcoming, "Upcoming epics");
        if (openRows.length >= LIMIT || upcomingRows.length >= LIMIT) throw new Error(`read reached the ${LIMIT}-item safety limit`);
        const rows = mergeProjectRows({ workspace, project: "", open: openRows, upcoming: upcomingRows });
        let context;
        try {
          const attempts = JSON.parse((await exec("aven-dispatch", ["list"], space?.folder ? { cwd: space.folder } : undefined)).stdout || "[]");
          const match = attempts.filter((attempt) => String(attempt?.worktree ?? "") === String(space?.folder ?? ""));
          let task, root;
          if (match.length === 1 && match[0].task_ref) {
            task = JSON.parse((await exec("aven", ["show", match[0].task_ref, "--json"], space?.folder ? { cwd: space.folder } : undefined)).stdout);
            root = task.is_epic ? task : task.epic_parent?.ref ? JSON.parse((await exec("aven", ["show", task.epic_parent.ref, "--json"], space?.folder ? { cwd: space.folder } : undefined)).stdout) : null;
          }
          context = resolveSpaceContext({ space, attempts, task, root, rows });
        } catch { context = { kind: "unavailable", name: String(space?.name ?? ""), folder: String(space?.folder ?? ""), message: "Dispatcher context is unavailable." }; }
        this.state = { loading: false, rows, context, coverageError: "", error: "", stale: false };
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

  async waitForDetail(address, reference, cx) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let readySince = 0;
    while (Date.now() < deadline) {
      try {
        const result = await hc(["read", address]);
        if (result.code === 0 && result.stdout.includes(reference)) {
          if (!readySince) readySince = Date.now();
          if (Date.now() - readySince >= READY_SETTLE_MS) return;
        } else readySince = 0;
      } catch {}
      await cx.sleep(READY_POLL_MS);
    }
    throw new Error(`Aven did not open ${reference} in time; the dispatcher shortcut was not sent.`);
  }

  dispatch(epic, action, cx) {
    const workspace = this.workspace();
    const identity = `${terminalIdentity(workspace, epic.id)}\u0000${action.id}`;
    const prefix = `${terminalName(workspace, epic.id)}${action.terminalKey}-`;
    if (this.pendingLaunches.has(identity)) return;
    const existing = terminals().find((terminal) => terminal.state === "live" && String(terminal.name ?? "").startsWith(prefix));
    if (existing) { void this.reveal(existing.address, cx); return; }
    this.pendingLaunches.add(identity);
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(this.space()?.folder || this.cwd());
        const name = `${prefix}${Date.now().toString(36)}`;
        const started = await hc(["run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name,
          ...(cwd ? ["--cwd", cwd] : []), "--", "aven", "--workspace", workspace, "tui", epic.ref]);
        if (started.code !== 0) throw new Error(started.stderr.trim() || `could not open ${epic.ref} in Aven`);
        const address = JSON.parse(started.stdout).address;
        await this.waitForDetail(address, epic.ref, taskCx);
        const sent = await hc(["keys", address, "z", action.detailKey]);
        if (sent.code !== 0) throw new Error(sent.stderr.trim() || `could not send ${action.label}`);
        await this.reveal(address, taskCx);
      } catch (error) {
        this.state = { ...this.state, error: String(error?.message ?? error) };
      } finally {
        this.pendingLaunches.delete(identity);
        this.notify(taskCx);
      }
    });
  }

  dispatchMenuButton(t, epic, cx) {
    const stop = (_event, clickCx) => clickCx.stop_propagation();
    const open = this.dispatchMenuEpicId === epic.id;
    return h_flex().id(`aven-dispatch-menu-${epic.id}`).h(23).px(7).gap(5).flex_none().items_center()
      .rounded(5).border(1).border_color(t.border).bg(open ? t.selected : t.chrome).text_size(10).text_color(open ? t.foreground : t.muted).cursor_pointer()
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click((_event, clickCx) => {
        clickCx.stop_propagation();
        this.dispatchMenuEpicId = open ? null : epic.id;
        this.notify(clickCx ?? cx);
      })
      .child("Dispatch")
      .child(div().text_color(t.dim).child(open ? "⌃" : "⌄"));
  }

  dispatchMenu(t, epic, cx) {
    const stop = (_event, clickCx) => clickCx.stop_propagation();
    return v_flex().id(`aven-dispatch-actions-${epic.id}`).mx(8).mt(4).p(4).gap(2).rounded(7).border(1).border_color(t.border).bg(t.popover)
      .children(DISPATCH_ACTIONS.map((action) => h_flex().id(`aven-dispatch-action-${action.id}-${epic.id}`).h(30).px(6).gap(9).items_center()
        .rounded(5).cursor_pointer().hover((style) => style.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click((_event, clickCx) => {
          clickCx.stop_propagation();
          this.dispatchMenuEpicId = null;
          this.notify(clickCx ?? cx);
          this.dispatch(epic, action, clickCx ?? cx);
        })
        .child(div().w(34).flex_none().text_size(10).font_semibold().text_color(t.accent).child(action.label))
        .child(div().flex_1().text_size(11).text_color(t.foreground).child(action.description))));
  }

  row(t, epic, cx) {
    const pinned = canonicalId(this.state.context?.pinned) === canonicalId(epic);
    return v_flex().id(`aven-epic-${epic.id}`).mx(8).px(9).py(7).gap(3).rounded(6).cursor_pointer().when(pinned, (el) => el.bg(t.selected))
      .hover((style) => style.bg(t.hover)).on_click((_event, clickCx) => this.launch(epic, clickCx ?? cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(epic.title))
        .child(div().flex_none().text_size(10).text_color(t.accent).child(epic.status))
        .child(this.dispatchMenuButton(t, epic, cx)))
      .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
        .child(div().flex_none().child(epic.ref)).child(div().min_w(0).truncate().child(epic.project)))
      .when(this.dispatchMenuEpicId === epic.id, (el) => el.child(this.dispatchMenu(t, epic, cx)));
  }

  render(cx) {
    const t = theme(), state = this.state, rows = scopeEpics(state.rows, this.scope, state.context);
    const scopeButton = (scope, label) => div().id(`aven-panel-scope-${scope}`).px(8).py(4).rounded(5).cursor_pointer().text_size(10.5)
      .bg(this.scope === scope ? t.selected : t.chrome).text_color(this.scope === scope ? t.foreground : t.muted)
      .hover((style) => style.bg(t.hover)).on_click((_event, clickCx) => { this.scope = scope; this.notify(clickCx); }).child(label);
    return v_flex().id("aven-panel").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_size_change((size, sizeCx) => { this.size = size; this.notify(sizeCx); })
      .child(h_flex().h(38).px(9).gap(5).items_center().flex_none()
        .child(div().flex_1().text_size(12).font_semibold().child("Aven epics"))
        .child(scopeButton("all", "All"))
        .child(scopeButton("space", "Space"))
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
         .when(!state.loading && !state.error && !state.coverageError && rows.length === 0, (el) => el.child(div().p(12).text_size(11.5).text_color(t.dim).child(this.scope === "space" ? "No root epic identified for this space." : "No epics in this project.")))
         .children(rows.map((epic) => this.row(t, epic, cx))));
  }
}
