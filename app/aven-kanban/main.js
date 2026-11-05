import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, focused, hc, nextCommand, props, run, spaces, terminals, theme } from "herdr";
import {
  ATTEMPT_LIMIT, BOARD_COLUMNS, DISPATCH_ACTIONS, assertBoardCoverage, buildBoard, detailArgs, dispatchTerminalName,
  epicArgs, indexAttempts, isLiveEpicTerminal, markMergedOnMain, mergeArgs, mergeEpicRows,
  moveSelection, openArgs, selectAttempt, selectedCard, terminalName, upcomingArgs,
} from "./logic.js";

const REFRESH_MS = 10000;
const METADATA_WORKERS = 4;
const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 50;
const READY_SETTLE_MS = 700;
const DETAIL_METADATA = [
  "sdd.plan-worked-out", "delivery.state", "delivery.target", "delivery.obligation",
];

function message(error) { return String(error?.message ?? error); }
function parse(result, label) {
  if (result.code !== 0) throw new Error(`${label}: ${(result.stderr || "").trim() || `exit ${result.code}`}`);
  return JSON.parse(result.stdout || "null");
}
function parseList(result, label) {
  const value = parse(result, label);
  if (!Array.isArray(value)) throw new Error(`${label}: expected a JSON list`);
  return value;
}
async function mapLimit(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(METADATA_WORKERS, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}
function safeDetail(payload) {
  const task = payload?.task ?? {};
  const metadata = {};
  for (const key of DETAIL_METADATA) {
    if (typeof payload?.metadata?.[key] === "string") metadata[key] = payload.metadata[key];
  }
  return {
    task: {
      id: String(task.id ?? ""), ref: String(task.ref ?? ""), title: String(task.title ?? ""),
      status: String(task.status ?? ""), is_epic: task.is_epic === true,
      epic_children: Array.isArray(task.epic_children) ? task.epic_children.map((child) => ({
        id: String(child?.id ?? ""), ref: String(child?.ref ?? ""), title: String(child?.title ?? ""),
        status: String(child?.status ?? ""), open: child?.open !== false,
      })) : [],
    },
    metadata,
  };
}

export default class AvenKanban extends View {
  init(_props, cx) {
    this.cx = cx;
    this.closed = false;
    this.refreshing = false;
    this.state = { loading: true, rows: [], attempts: [], error: "", coverageError: "", stale: false };
    this.details = new Map();
    this.pendingLaunches = new Set();
    this.pendingMerges = new Set();
    this.mainEvidence = { head: "", entries: new Map() };
    this.selectedId = "";
    this.dispatchMenuEpicId = null;
    this.folder = String(props()?.cwd ?? "");
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (timerCx) => this.refresh(timerCx));
    this.commands(cx);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeOverlay(props().overlay);
  }

  workspace() { return String(props()?.workspace ?? "default"); }
  space() {
    const id = focused()?.space;
    return spaces().find((space) => space.id === id) ?? spaces().find((space) => space.active) ?? null;
  }
  spaceFolder() {
    const space = this.space();
    const focus = focused();
    return focus?.space === space?.id && focus.cwd
      ? focus.cwd
      : (space?.folder || this.folder || String(props()?.cwd ?? ""));
  }
  notify(cx) { if (!this.closed) { try { (cx ?? this.cx).notify(); } catch {} } }

  commands(cx) {
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) return;
        const name = String(command).split(".").pop();
        if (name === "close") this.close();
        else if (name === "refresh") this.refresh(cx);
        else if (name === "next") this.select(1, cx);
        else if (name === "previous") this.select(-1, cx);
        else if (name === "open") this.openSelected(cx);
        else if (name === "dispatch") this.toggleDispatch(cx);
        else if (name === "plan" || name === "plan-implement" || name === "implement") this.dispatchSelected(name, cx);
        else if (name === "merge") this.mergeSelected(cx);
        else cx.notify();
      }
    });
  }

  async rootFolder(folder) {
    if (!folder) {
      try {
        const current = await exec("pwd", []);
        folder = current.code === 0 ? current.stdout.trim() : "";
      } catch {}
    }
    if (!folder) return "";
    try {
      const result = await exec("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
      const common = result.code === 0 ? result.stdout.trim().replace(/\/+$/, "") : "";
      return common.endsWith("/.git") ? common.slice(0, -5) : folder;
    } catch { return folder; }
  }

  // Read-only delivery evidence for terminal cards. Exact attempt commits are
  // checked against one resolved local main head; this never mutates Aven or Git.
  async evidenceFromMain(cwd, rows, attemptIndex) {
    if (!cwd) return { merged: new Set(), error: "Local main is unavailable; delivery ancestry was not checked." };
    const headResult = await exec("git", ["-C", cwd, "rev-parse", "--verify", "main"]);
    if (headResult.code !== 0) {
      const detail = String(headResult.stderr ?? "").trim();
      return { merged: new Set(), error: `Local main is unavailable at ${cwd}; delivery ancestry was not checked${detail ? `: ${detail}` : "."}` };
    }
    const head = headResult.stdout.trim();
    if (this.mainEvidence.head !== head) this.mainEvidence = { head, entries: new Map() };
    const merged = new Set();
    for (const row of rows) {
      if (row.status !== "done" && row.status !== "canceled") continue;
      const attempt = selectAttempt(attemptIndex.get(row.id) ?? [], row.id).attempt;
      if (!attempt) continue;
      const commits = new Set();
      if (attempt.branch) {
        const branch = await exec("git", ["-C", cwd, "rev-parse", "--verify", `${attempt.branch}^{commit}`]);
        if (branch.code === 0 && branch.stdout.trim()) commits.add(branch.stdout.trim());
      }
      if (attempt.worktree) {
        const worktree = await exec("git", ["-C", attempt.worktree, "rev-parse", "HEAD"]);
        if (worktree.code === 0 && worktree.stdout.trim()) commits.add(worktree.stdout.trim());
      }
      for (const commit of commits) {
        let contained = this.mainEvidence.entries.get(commit);
        if (contained === undefined) {
          const ancestry = await exec("git", ["-C", cwd, "merge-base", "--is-ancestor", commit, head]);
          contained = ancestry.code === 0;
          this.mainEvidence.entries.set(commit, contained);
        }
        if (contained) { merged.add(row.id); break; }
      }
    }
    return { merged, error: "" };
  }

  refresh(cx) {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    this.state = { ...this.state, loading: !this.state.rows.length, error: "" };
    this.notify(cx);
    cx.spawn(async (taskCx) => {
      try {
        const workspace = this.workspace();
        const cwd = await this.rootFolder(this.spaceFolder());
        const [availableResult, upcomingResult, attemptsResult] = await Promise.all([
          exec("aven", epicArgs(workspace), cwd ? { cwd } : undefined),
          exec("aven", upcomingArgs(workspace), cwd ? { cwd } : undefined),
          exec("aven-dispatch", ["list", "--summary", "--limit", String(ATTEMPT_LIMIT)], cwd ? { cwd } : undefined),
        ]);
        const available = parseList(availableResult, "Epics");
        const upcoming = parseList(upcomingResult, "Upcoming epics");
        assertBoardCoverage({ available: available.length, upcoming: upcoming.length });
        const rawAttempts = parseList(attemptsResult, "Dispatcher attempts");
        assertBoardCoverage({ attempts: rawAttempts.length });
        const baseRows = mergeEpicRows({ available, upcoming });
        assertBoardCoverage({ epics: baseRows.length });
        const currentIds = new Set(baseRows.map((row) => row.id));
        for (const id of this.details.keys()) if (!currentIds.has(id)) this.details.delete(id);
        const needed = baseRows.filter((row) => this.details.get(row.id)?.updatedAt !== row.updated_at);
        const failures = [];
        await mapLimit(needed, async (row) => {
          try {
            const result = await exec("aven", detailArgs(workspace, row.ref), cwd ? { cwd } : undefined);
            const detail = safeDetail(parse(result, `Epic ${row.ref}`));
            if (detail.task.id !== row.id || !detail.task.is_epic) throw new Error("identity mismatch");
            this.details.set(row.id, { updatedAt: row.updated_at, detail });
          } catch (error) {
            failures.push(`${row.ref}: ${message(error)}`);
          }
        });
        const details = {};
        for (const row of baseRows) {
          const cached = this.details.get(row.id);
          if (cached?.updatedAt === row.updated_at) details[row.id] = cached.detail;
        }
        const baseWithDetails = mergeEpicRows({ available, upcoming, details });
        const attemptIndex = indexAttempts(rawAttempts);
        const attempts = [...attemptIndex.values()].flat();
        const mainEvidence = await this.evidenceFromMain(cwd, baseWithDetails, attemptIndex);
        const rows = markMergedOnMain(baseWithDetails, mainEvidence.merged);
        const board = buildBoard({ rows, attemptIndex });
        this.selectedId = selectedCard(board, this.selectedId)?.id ?? moveSelection(board, "", 1);
        const coverage = [];
        if (failures.length) coverage.push(`${failures.length} epic metadata read(s) failed: ${failures.slice(0, 3).join("; ")}`);
        if (mainEvidence.error) coverage.push(mainEvidence.error);
        this.state = {
          loading: false, rows, attempts, attemptIndex, error: "", stale: false,
          coverageError: coverage.join("; "),
        };
      } catch (error) {
        this.state = { ...this.state, loading: false, error: message(error), stale: this.state.rows.length > 0 };
      } finally {
        this.refreshing = false;
        this.notify(taskCx);
      }
    });
  }

  columns() { return buildBoard(this.state); }
  selected() { return selectedCard(this.columns(), this.selectedId); }

  select(delta, cx) {
    this.selectedId = moveSelection(this.columns(), this.selectedId, delta);
    this.dispatchMenuEpicId = null;
    this.notify(cx);
  }

  selectCard(card, cx) {
    this.selectedId = card.id;
    this.dispatchMenuEpicId = null;
    this.notify(cx);
  }

  openSelected(cx) { const card = this.selected(); if (card) this.open(card, cx); }
  dispatchSelected(actionId, cx) {
    const card = this.selected();
    const action = DISPATCH_ACTIONS.find((candidate) => candidate.id === actionId);
    if (card && action) this.dispatch(card, action, cx);
  }
  mergeSelected(cx) { const card = this.selected(); if (card) this.merge(card, cx); }
  toggleDispatch(cx) {
    const card = this.selected();
    if (!card || card.status === "done" || card.status === "canceled") return;
    this.dispatchMenuEpicId = this.dispatchMenuEpicId === card.id ? null : card.id;
    this.notify(cx);
  }

  async reveal(address, cx) {
    if (!address) return;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline && !this.closed) {
      try {
        const result = await exec("herdr-app", ["do", "terminal.peek", "--terminal", address]);
        if (result.code === 0) {
          this.close();
          run("terminal.peek", { terminal: address });
          return;
        }
      } catch { break; }
      await cx.sleep(READY_POLL_MS);
    }
    this.close();
    run("terminal.peek", { terminal: address });
  }

  open(epic, cx) {
    const workspace = this.workspace();
    const identity = terminalName(workspace, epic.id);
    if (this.pendingLaunches.has(identity)) return;
    const existing = terminals().find((terminal) => isLiveEpicTerminal(terminal, workspace, epic.id));
    if (existing) { void this.reveal(existing.address, cx); return; }
    this.pendingLaunches.add(identity);
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(this.spaceFolder());
        const name = `${identity}${Date.now().toString(36)}`;
        const result = await hc(openArgs({ workspace, epic, cwd, name }));
        if (result.code !== 0) throw new Error((result.stderr || "").trim() || "could not start Aven");
        await this.reveal(JSON.parse(result.stdout).address, taskCx);
      } catch (error) {
        this.state = { ...this.state, error: message(error) };
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
    if (epic.status === "done" || epic.status === "canceled") return;
    const workspace = this.workspace();
    const identity = `${terminalName(workspace, epic.id)}\u0000${action.id}`;
    const prefix = dispatchTerminalName(workspace, epic.id, action);
    if (this.pendingLaunches.has(identity)) return;
    const existing = terminals().find((terminal) => terminal.state === "live" && String(terminal.name ?? "").startsWith(prefix));
    if (existing) { void this.reveal(existing.address, cx); return; }
    this.pendingLaunches.add(identity);
    this.dispatchMenuEpicId = null;
    cx.spawn(async (taskCx) => {
      try {
        const cwd = await this.rootFolder(this.spaceFolder());
        const name = `${prefix}${Date.now().toString(36)}`;
        const started = await hc(openArgs({ workspace, epic, cwd, name }));
        if (started.code !== 0) throw new Error(started.stderr.trim() || `could not open ${epic.ref} in Aven`);
        const address = JSON.parse(started.stdout).address;
        await this.waitForDetail(address, epic.ref, taskCx);
        const sent = await hc(["keys", address, "z", action.detailKey]);
        if (sent.code !== 0) throw new Error(sent.stderr.trim() || `could not send ${action.label}`);
        await this.reveal(address, taskCx);
      } catch (error) {
        this.state = { ...this.state, error: message(error) };
      } finally {
        this.pendingLaunches.delete(identity);
        this.notify(taskCx);
      }
    });
  }

  merge(epic, cx) {
    if (!epic.mergeable || this.pendingMerges.has(epic.id)) return;
    this.pendingMerges.add(epic.id);
    cx.spawn(async (taskCx) => {
      try {
        const args = mergeArgs(epic, epic.attempt);
        const cwd = epic.attempt.worktree || await this.rootFolder(this.spaceFolder());
        const result = await exec("aven-dispatch", args, cwd ? { cwd } : undefined);
        if (result.code !== 0) throw new Error((result.stderr || "").trim() || "the review session is busy or unavailable");
        await this.reveal(epic.mergeTerminal.address, taskCx);
      } catch (error) {
        this.state = { ...this.state, error: `Merge handoff failed: ${message(error)}` };
      } finally {
        this.pendingMerges.delete(epic.id);
        this.notify(taskCx);
      }
    });
  }

  button(id, label, onClick, primary = false) {
    const t = theme();
    return div().id(id).px(7).py(4).rounded(5).flex_none().cursor_pointer().text_size(10)
      .bg(primary ? t.selected : t.raised).text_color(primary ? t.accent : t.muted)
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
      .on_click((event, cx) => { cx.stop_propagation(); onClick(event, cx); })
      .child(label);
  }

  dispatchMenu(card, cx) {
    const t = theme();
    return v_flex().id(`aven-kanban-actions-${card.id}`).pt(3).gap(2).children(DISPATCH_ACTIONS.map((action) =>
      h_flex().id(`aven-kanban-action-${action.id}-${card.id}`).px(5).py(4).gap(6).items_center().rounded(4)
        .cursor_pointer().hover((style) => style.bg(t.hover))
        .on_mouse_down("left", (_event, clickCx) => clickCx.stop_propagation())
        .on_click((_event, clickCx) => { clickCx.stop_propagation(); this.dispatch(card, action, clickCx ?? cx); })
        .child(div().w(28).flex_none().text_size(9).font_semibold().text_color(t.accent).child(action.label))
        .child(div().flex_1().min_w(0).text_size(9.5).text_color(t.foreground).child(action.description))));
  }

  card(card, cx) {
    const t = theme();
    const selected = card.id === this.selectedId;
    const open = card.status !== "done" && card.status !== "canceled";
    return v_flex().id(`aven-kanban-card-${card.id}`).p(8).gap(5).rounded(7).border(1)
      .border_color(selected ? t.accent : t.border).bg(selected ? t.selected : t.background).cursor_pointer()
      .on_click((_event, clickCx) => this.selectCard(card, clickCx ?? cx))
      .child(h_flex().gap(5).items_center()
        .child(div().flex_none().text_size(9.5).font_semibold().text_color(t.accent).child(card.ref))
        .child(div().flex_1())
        .child(div().flex_none().text_size(9).text_color(t.dim).child(card.status)))
      .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child(card.title))
      .child(h_flex().gap(5).items_center().text_size(9).text_color(t.muted)
        .when(card.phases.total > 0, (el) => el.child(div().child(`${card.phases.complete}/${card.phases.total} phases`)))
        .when(card.planWorkedOut, (el) => el.child(div().child("planned")))
        .when(card.mergedOnMain, (el) => el.child(div().child("on main")))
        .when(card.executionState, (el) => el.child(div().child(card.executionState)))
        .when(card.deliveryState, (el) => el.child(div().child(`delivery ${card.deliveryState}`))))
      .when(card.warnings.length > 0, (el) => el.child(div().text_size(9).text_color(t.blocked).child(card.warnings.join(" "))))
      .child(h_flex().gap(4).items_center()
        .child(this.button(`aven-kanban-open-${card.id}`, "Open", (_event, clickCx) => this.open(card, clickCx)))
        .when(open, (el) => el.child(this.button(`aven-kanban-dispatch-${card.id}`, this.dispatchMenuEpicId === card.id ? "Dispatch ⌃" : "Dispatch ⌄", (_event, clickCx) => {
          this.selectedId = card.id;
          this.dispatchMenuEpicId = this.dispatchMenuEpicId === card.id ? null : card.id;
          this.notify(clickCx);
        })))
        .when(card.mergeable, (el) => el.child(this.button(`aven-kanban-merge-${card.id}`, "Merge into main", (_event, clickCx) => this.merge(card, clickCx), true))))
      .when(card.mergeable, (el) => el.child(div().text_size(8.5).text_color(t.dim).child("via /ha-merge · confirmation required")))
      .when(this.dispatchMenuEpicId === card.id, (el) => el.child(this.dispatchMenu(card, cx)));
  }

  column(column, cx) {
    const t = theme();
    return v_flex().id(`aven-kanban-column-${column.id}`).w(238).flex_none().h_full().min_h(0).rounded(8)
      .border(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().h(36).px(10).gap(6).items_center().flex_none()
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.foreground).child(column.title))
        .child(div().text_size(10).text_color(t.dim).child(String(column.cards.length))))
      .child(div().h(1).flex_none().bg(t.border))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(6)
        .when(column.cards.length === 0, (el) => el.child(div().p(8).text_size(10).text_color(t.dim).child("No epics")))
        .children(column.cards.map((card) => this.card(card, cx))));
  }

  render(cx) {
    const t = theme();
    const columns = this.columns();
    const count = columns.reduce((total, column) => total + column.cards.length, 0);
    return v_flex().id("aven-kanban").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .track_focus(this.handle)
      .on_size_change((_size, sizeCx) => { if (!this.closed) { this.handle.focus(); this.notify(sizeCx); } })
      .on_key_down((event, keyCx) => {
        const key = event.key;
        if (key === "escape") {
          if (this.dispatchMenuEpicId) { this.dispatchMenuEpicId = null; this.notify(keyCx); }
          else this.close();
        } else if (key === "j" || key === "down") this.select(1, keyCx);
        else if (key === "k" || key === "up") this.select(-1, keyCx);
        else if (key === "enter" || key === "o") this.openSelected(keyCx);
        else if (key === "d") this.toggleDispatch(keyCx);
        else if (key === "s") this.dispatchSelected("plan-implement", keyCx);
        else if (key === "p") this.dispatchSelected("plan", keyCx);
        else if (key === "i") this.dispatchSelected("implement", keyCx);
        else if (key === "m") this.mergeSelected(keyCx);
        else if (key === "r") this.refresh(keyCx);
        else return;
        keyCx.stop_propagation();
        keyCx.notify();
      })
      .child(h_flex().h(48).px(14).gap(10).items_center().flex_none()
        .child(v_flex().flex_1().gap(1)
          .child(div().text_size(15).font_semibold().child("Aven Kanban"))
          .child(div().text_size(9.5).text_color(t.dim).child(`${this.state.rows[0]?.project ?? "Current project"} · ${count} epics`)))
        .child(this.button("aven-kanban-refresh", this.refreshing ? "Refreshing…" : "Refresh", (_event, clickCx) => this.refresh(clickCx)))
        .child(div().text_size(10).text_color(t.dim).child("Esc")))
      .child(h_flex().min_h(28).px(14).pb(5).gap(8).items_center().flex_none().text_size(9.5).text_color(t.muted)
        .child(div().flex_1().child("j/k select · Enter open · d dispatch · s plan+implement · m merge · r refresh"))
        .child(div().child(BOARD_COLUMNS.map((column) => column.title).join(" → "))))
      .when(Boolean(this.state.error), (el) => el.child(div().mx(12).mb(6).p(8).rounded(6).text_size(10).text_color(t.blocked).bg(t.raised).child(this.state.error)))
      .when(Boolean(this.state.coverageError), (el) => el.child(div().mx(12).mb(6).p(8).rounded(6).text_size(10).text_color(t.blocked).bg(t.raised).child(`Incomplete metadata: ${this.state.coverageError}`)))
      .when(this.state.stale, (el) => el.child(div().mx(12).mb(6).text_size(9.5).text_color(t.dim).child("Showing last successful results (stale).")))
      .child(h_flex().flex_1().min_h(0).overflow_x_scrollbar().p(10).gap(10)
        .when(this.state.loading, (el) => el.child(div().p(16).text_size(11).text_color(t.dim).child("Loading epics…")))
        .when(!this.state.loading && count === 0, (el) => el.child(div().p(16).text_size(11).text_color(t.dim).child("No epics in this project.")))
        .when(!this.state.loading && count > 0, (el) => el.children(columns.map((column) => this.column(column, cx)))));
  }
}
