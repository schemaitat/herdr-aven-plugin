import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, focused, hc, props, run, spaces, terminals, theme } from "herdr";
import { DISPATCH_ACTIONS, LIMIT, SUMMARY_LABEL, canonicalId, descriptionBody, descriptionSnippet, dispatchLabel, dispatchTargets, focusedPhase, fullDetail, inferredEpicArgs, inferredUpcomingArgs, launchArgs, lifecycleStage, mergeProjectRows, phaseOverview, phaseProgress, projectTone, resolveSpaceContext, scopeEpics, statusLabel, taskSummary, terminalIdentity, terminalName, isLiveEpicTerminal } from "./logic.js";

const REFRESH_MS = 10000;
const FOCUS_POLL_MS = 1000;
const PHASE_GLYPH = { done: "✓", active: "●", canceled: "–", todo: "○", backlog: "○", inbox: "○" };
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
    this.phaseDetails = new Map();
    this.phaseReads = new Set();
    this.openPhaseRef = "";
    this.scope = "all";
    this.dispatchMenuEpicId = null;
    this.focusedSpace = focused()?.space ?? "";
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (timerCx) => this.refresh(timerCx));
    // A focused worktree changes the whole context card, so react to focus
    // changes instead of waiting for the next data refresh.
    cx.timer.every(FOCUS_POLL_MS, (timerCx) => {
      const id = focused()?.space ?? "";
      if (id === this.focusedSpace) return;
      this.focusedSpace = id;
      this.refresh(timerCx);
    });
  }

  async close() { this.closed = true; }

  workspace() { return String(props()?.workspace ?? "default"); }
  cwd() { return String(props()?.cwd ?? ""); }
  space() { const id = focused()?.space; return spaces().find((space) => space.id === id) ?? spaces().find((space) => space.active) ?? null; }

  spaceCwd(space) {
    const focus = focused();
    // A space's folder is only the default for new terminals. Its visible
    // terminal can be in a nested checkout (or the space can point at $HOME).
    return focus?.space === space?.id && focus.cwd ? focus.cwd : (this.cwd() || space?.folder || "");
  }

  async worktreeFolder(folder) {
    if (!folder) return "";
    try {
      const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder });
      if (result.code === 0 && result.stdout.trim()) return result.stdout.trim().replace(/\/+$/, "");
    } catch {}
    return folder.replace(/\/+$/, "");
  }

  async rootFolder(folder) {
    if (!folder) return undefined;
    try {
      const result = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: folder });
      const common = result.code === 0 ? result.stdout.trim().replace(/\/+$/, "") : "";
      return common.endsWith("/.git") ? common.slice(0, -5) : folder;
    } catch { return folder; }
  }

  notify(cx) { if (!this.closed) { try { cx.notify(); } catch {} } }

  async readPhaseDescription(ref, force = false) {
    if (this.phaseReads.has(ref)) return;
    const previous = this.phaseDetails.get(ref);
    if (!force && previous && !previous.error) return;
    this.phaseReads.add(ref);
    this.phaseDetails.set(ref, { loading: true, description: previous?.description ?? "", summary: previous?.summary ?? null, error: "" });
    try {
      const result = await exec("aven", ["show", ref, "--workspace", this.workspace(), "--full", "--json"]);
      if (result.code !== 0) throw new Error((result.stderr || "").trim() || `could not read ${ref}`);
      const payload = JSON.parse(result.stdout);
      const detail = fullDetail(payload);
      if (detail?.ref && detail.ref !== ref) throw new Error(`identity mismatch for ${ref}`);
      this.phaseDetails.set(ref, {
        loading: false,
        description: String(detail?.description ?? ""),
        summary: taskSummary(detail),
        error: "",
      });
    } catch (error) {
      this.phaseDetails.set(ref, { loading: false, description: "", summary: null, error: String(error?.message ?? error) });
    } finally {
      this.phaseReads.delete(ref);
    }
  }

  // Descriptions are cached for the session and read with the same bounded
  // concurrency as the rest of the panel. Pruning follows the current root so
  // a different worktree starts from an empty, relevant cache.
  async hydratePhases(phases, cx) {
    const refs = new Set(phases.map((phase) => phase.ref));
    for (const ref of [...this.phaseDetails.keys()]) if (!refs.has(ref)) this.phaseDetails.delete(ref);
    if (this.openPhaseRef && !refs.has(this.openPhaseRef)) this.openPhaseRef = "";
    const missing = phases.filter((phase) => !this.phaseDetails.has(phase.ref) && !this.phaseReads.has(phase.ref));
    if (!missing.length) return;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
      for (;;) {
        const phase = missing[next];
        next += 1;
        if (!phase) return;
        await this.readPhaseDescription(phase.ref);
      }
    }));
    this.notify(cx);
  }

  togglePhase(ref, cx) {
    this.openPhaseRef = this.openPhaseRef === ref ? "" : ref;
    this.notify(cx);
    if (!this.openPhaseRef) return;
    const detail = this.phaseDetails.get(ref);
    if (this.phaseReads.has(ref) || (detail && !detail.error)) return;
    cx.spawn(async (taskCx) => {
      await this.readPhaseDescription(ref);
      this.notify(taskCx);
    });
  }

  refresh(cx) {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    this.state = { ...this.state, loading: !this.state.rows.length, error: "" };
    this.notify(cx);
    cx.spawn(async (taskCx) => {
      try {
        const workspace = this.workspace();
        const space = this.space();
        const spaceCwd = this.spaceCwd(space);
        const cwd = await this.rootFolder(spaceCwd);
        const [open, upcoming] = await Promise.all([
          exec("aven", inferredEpicArgs(workspace), cwd ? { cwd } : undefined),
          exec("aven", inferredUpcomingArgs(workspace), cwd ? { cwd } : undefined),
        ]);
        const openRows = parse(open, "Open epics"), upcomingRows = parse(upcoming, "Upcoming epics");
        if (openRows.length >= LIMIT || upcomingRows.length >= LIMIT) throw new Error(`read reached the ${LIMIT}-item safety limit`);
        const rows = mergeProjectRows({ workspace, project: "", open: openRows, upcoming: upcomingRows });
        let context;
        try {
          const worktree = await this.worktreeFolder(spaceCwd);
          const contextSpace = { ...space, folder: worktree };
          const cwdOption = worktree ? { cwd: worktree } : undefined;
          const attemptsResult = await exec("aven-dispatch", ["list", "--summary"], cwdOption);
          if (attemptsResult.code !== 0) throw new Error((attemptsResult.stderr || "").trim() || "could not read dispatcher attempts");
          const attempts = JSON.parse(attemptsResult.stdout || "[]");
          const targets = dispatchTargets(attempts, worktree);
          const target = targets.length === 1 ? targets[0] : null;
          const readTask = async (ref) => {
            const result = await exec("aven", ["show", ref, "--workspace", workspace, "--full", "--json"], cwdOption);
            if (result.code !== 0) throw new Error((result.stderr || "").trim() || `could not read ${ref}`);
            const payload = JSON.parse(result.stdout);
            return fullDetail(payload);
          };
          let task, root;
          if (target?.taskRef) {
            task = await readTask(target.taskRef);
            root = task.is_epic
              ? task
              : task.epic_parent?.ref
                ? await readTask(task.epic_parent.ref)
                : target.attempt?.task_ref && target.attempt.task_ref !== target.taskRef
                  ? await readTask(target.attempt.task_ref)
                  : null;
          }
          context = resolveSpaceContext({ space: contextSpace, attempts, task, root, rows, target });
        } catch { context = { kind: "unavailable", name: String(space?.name ?? ""), folder: String(spaceCwd), message: "Dispatcher context is unavailable; showing project epics." }; }
        this.state = { loading: false, rows, context, coverageError: "", error: "", stale: false };
        if (context?.kind === "dispatch") {
          await this.hydratePhases(context.root?.epic_children ?? [], taskCx);
          // The focused and expanded phases are the ones a user reads after
          // pressing d l; re-read them so a fresh summary appears promptly.
          const focusRef = focusedPhase(context.root, context.task)?.phase?.ref ?? "";
          for (const ref of new Set([this.openPhaseRef, focusRef])) {
            if (ref) await this.readPhaseDescription(ref, true);
          }
        }
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
        const cwd = await this.rootFolder(this.spaceCwd(this.space()));
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

  stageTone(t, stage) {
    if (stage === "Review") return t.accent;
    if (stage === "In progress") return t.working;
    if (stage === "Done") return t.done;
    if (stage === "Canceled") return t.dim;
    return t.muted;
  }

  dispatchTone(t, state) {
    const value = String(state ?? "");
    if (!value) return t.dim;
    if (/review|completed/.test(value)) return t.accent;
    if (/running|waiting|pending|starting|queued/.test(value)) return t.working;
    if (/fail|interrupt|block/.test(value)) return t.blocked;
    return t.muted;
  }

  statusChip(t, status) {
    const tone = this.stageTone(t, lifecycleStage({ status }));
    return h_flex().gap(4).flex_none().items_center()
      .child(div().size(5).rounded(3).bg(tone))
      .child(div().text_size(10).text_color(tone).child(statusLabel(status)));
  }

  projectChip(project) {
    const tone = projectTone(project);
    return div().flex_none().px(5).py(1).rounded(3).bg(tone.bg).text_color(tone.fg)
      .text_size(9.5).child(String(project ?? "").trim() || "unassigned");
  }

  phaseRow(t, phase, cx) {
    const tone = this.stageTone(t, lifecycleStage({ status: phase.status }));
    const marker = phase.active
      ? { label: "ACTIVE", color: t.working }
      : phase.worktree
        ? { label: "WORKTREE", color: t.accent }
        : null;
    const open = this.openPhaseRef === phase.ref;
    const detail = this.phaseDetails.get(phase.ref);
    const summary = detail?.summary ?? null;
    const snippet = summary ? (summary.lines[0] ?? "") : descriptionSnippet(detail?.description ?? "", 120);
    const body = detail?.loading
      ? "Loading description…"
      : detail?.error
        ? detail.error
        : descriptionBody(detail?.description ?? "") || "No description.";
    return v_flex().id(`aven-panel-phase-${phase.ref}`).gap(2).rounded(4)
      .when(phase.worktree, (el) => el.bg(t.selected).border_l(2).border_color(t.accent))
      .child(h_flex().id(`aven-panel-phase-head-${phase.ref}`).min_h(20).px(4).gap(6).items_center().cursor_pointer()
        .hover((style) => style.bg(t.hover))
        .on_click((_event, clickCx) => { clickCx.stop_propagation(); this.togglePhase(phase.ref, clickCx ?? cx); })
        .child(div().flex_none().w(9).text_size(10).text_color(tone).child(PHASE_GLYPH[phase.status] ?? "○"))
        .child(div().flex_none().w(14).text_size(9.5).text_color(t.dim).child(`${phase.position}.`))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(10).text_color(phase.worktree ? t.foreground : t.muted).child(`${phase.ref} · ${phase.title}`))
          .when(Boolean(snippet), (el) => el.child(div().truncate().text_size(9).text_color(t.dim)
            .child(summary ? `${SUMMARY_LABEL} · ${snippet}` : snippet))))
        .when(Boolean(marker), (el) => el.child(div().flex_none().px(4).py(1).rounded(3).bg(marker.color)
          .text_color(t.background).text_size(8.5).font_semibold().child(marker.label)))
        .child(div().flex_none().text_size(9).text_color(t.dim).child(open ? "⌃" : "⌄")))
      .when(open, (el) => el.child(v_flex().id(`aven-panel-phase-body-${phase.ref}`).w_full().min_w(0).mx(4).mb(3).px(6).py(5).rounded(4)
        .bg(t.background).gap(3)
        .when(Boolean(summary), (row) => row.child(h_flex().gap(5).items_center()
          .child(div().text_size(8.5).font_semibold().text_color(t.accent).child(SUMMARY_LABEL))
          .when(Boolean(summary?.stale), (staleRow) => staleRow.child(div().text_size(8.5).text_color(t.blocked).child("stale")))))
        .when(Boolean(summary), (row) => row.children((summary?.lines ?? []).map((line) => h_flex().w_full().min_w(0).gap(4).items_start()
          .child(div().flex_none().text_size(10).text_color(t.accent).child("•"))
          .child(div().flex_1().min_w(0).whitespace_normal().text_size(10).text_color(t.muted).child(line)))))
        .when(!summary, (row) => row.child(div().w_full().min_w(0).whitespace_normal().text_size(10).text_color(detail?.error ? t.blocked : t.muted).child(body)))));
  }

  smallButton(t, id, text, onClick) {
    return div().id(id).px(7).py(4).rounded(5).cursor_pointer().text_size(10).bg(t.selected).text_color(t.foreground)
      .hover((style) => style.bg(t.hover)).on_click((_event, clickCx) => onClick(clickCx)).child(text);
  }

  spaceCard(t, cx) {
    const context = this.state.context;
    if (!context) return null;
    if (context.kind !== "dispatch") {
      return v_flex().mx(8).my(7).p(8).gap(2).rounded(6).bg(t.raised)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child("CURRENT SPACE"))
        .child(div().text_size(11.5).truncate().child(context.name || "Unnamed space"))
        .when(Boolean(context.folder), (row) => row.child(div().text_size(10.5).truncate().text_color(t.dim).child(context.folder)))
        .child(div().text_size(10.5).text_color(t.muted).child(context.message));
    }
    const { root, task, attempt } = context;
    const { phase } = focusedPhase(root, task);
    const overview = phaseOverview(root, task);
    const progress = phaseProgress(root.epic_children);
    const stage = lifecycleStage({ status: task?.status, attempt });
    const agent = [attempt?.agent, String(attempt?.model ?? "").split("/").pop()].filter(Boolean).join(" · ");
    const detailSummary = taskSummary(task);
    const taskDescription = descriptionSnippet(task?.description ?? "", 160);
    return v_flex().mx(8).my(7).p(8).gap(5).rounded(6).bg(t.raised)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(10).font_semibold().text_color(t.dim).child("WORKTREE"))
        .child(div().flex_1())
        .child(div().id("aven-panel-lifecycle").text_size(10).font_semibold().text_color(this.stageTone(t, stage)).child(stage)))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_color(t.accent).child("◆"))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_semibold().text_color(t.foreground).child(root.ref))
        .child(this.statusChip(t, root.status)))
      .child(div().text_size(11).text_color(t.muted).truncate().child(root.title))
      .when(progress.total > 0, (el) => el.child(h_flex().gap(7).items_center()
        .child(div().flex_1().min_w(0).h(3).rounded(2).bg(t.border).overflow_hidden()
          .child(div().h_full().w(`${Math.round((progress.complete / progress.total) * 100)}%`).rounded(2).bg(t.accent)))
        .child(div().flex_none().text_size(10).text_color(t.dim).child(`${progress.complete}/${progress.total} phases`))))
      .child(div().h(1).flex_none().bg(t.border))
      .when(overview.phases.length > 0, (el) => el.child(v_flex().id("aven-panel-phases").gap(1)
        .child(h_flex().gap(6).items_center().px(4)
          .child(div().text_size(9.5).font_semibold().text_color(t.dim).child("PHASES"))
          .child(div().flex_1())
          .child(div().text_size(9.5).text_color(t.dim).child(`${progress.complete}/${progress.total}`)))
        .children(overview.phases.map((entry) => this.phaseRow(t, entry, cx)))))
      .when(overview.phases.length > 0, (el) => el.child(div().h(1).flex_none().bg(t.border)))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().w(38).text_size(10).text_color(t.dim).child("TASK"))
        .child(div().id("aven-panel-task").flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.foreground).child(task.ref))
        .child(this.statusChip(t, task.status)))
      .child(div().text_size(10.5).text_color(t.muted).truncate().child(task.title))
      .when(Boolean(detailSummary), (el) => el.child(v_flex().gap(1).pt(1)
        .child(h_flex().gap(5).items_center()
          .child(div().text_size(8.5).font_semibold().text_color(t.accent).child(SUMMARY_LABEL))
          .when(Boolean(detailSummary?.stale), (staleRow) => staleRow.child(div().text_size(8.5).text_color(t.blocked).child("stale"))))
        .children((detailSummary?.lines ?? []).map((line) => h_flex().w_full().min_w(0).gap(4).items_start()
          .child(div().flex_none().text_size(10).text_color(t.accent).child("•"))
          .child(div().flex_1().min_w(0).whitespace_normal().text_size(10).text_color(t.dim).child(line))))))
      .when(!detailSummary && Boolean(taskDescription), (el) => el.child(div().w_full().min_w(0).whitespace_normal().text_size(10).text_color(t.dim).child(taskDescription)))
      .child(h_flex().gap(6).items_center()
        .child(div().size(6).rounded(3).flex_none().bg(this.dispatchTone(t, attempt?.state)))
        .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.foreground).child(dispatchLabel(attempt?.state)))
        .when(Boolean(agent), (row) => row.child(div().flex_none().text_size(10).text_color(t.dim).child(agent))))
      .when(Boolean(attempt?.execution_mode), (el) => el.child(div().text_size(10).text_color(t.dim).child(attempt.execution_mode)))
      .when(Boolean(attempt?.lifecycle?.contradiction), (el) => el.child(div().text_size(10).text_color(t.blocked).child(String(attempt.lifecycle.contradiction).replaceAll("_", " "))))
      .child(h_flex().gap(6).pt(1)
        .child(this.smallButton(t, "aven-panel-open-task", "Open task", (clickCx) => this.launch(task, clickCx ?? cx)))
        .when(Boolean(phase && phase.ref !== task.ref), (row) => row.child(this.smallButton(t, "aven-panel-open-phase", "Open phase", (clickCx) => this.launch(phase, clickCx ?? cx)))));
  }

  row(t, epic, cx) {
    const pinned = canonicalId(this.state.context?.pinned) === canonicalId(epic);
    const tone = projectTone(epic.project);
    return v_flex().id(`aven-epic-${epic.id}`).mx(8).px(9).py(7).gap(3).rounded(6).border_l(3).border_color(tone.fg)
      .cursor_pointer().when(pinned, (el) => el.bg(t.selected))
      .hover((style) => style.bg(t.hover)).on_click((_event, clickCx) => this.launch(epic, clickCx ?? cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(epic.title))
        .child(div().flex_none().text_size(10).text_color(t.accent).child(epic.status))
        .child(this.dispatchMenuButton(t, epic, cx)))
      .child(h_flex().gap(6).text_size(10.5).text_color(t.dim)
        .child(div().flex_none().child(epic.ref)).child(this.projectChip(epic.project)))
      .when(this.dispatchMenuEpicId === epic.id, (el) => el.child(this.dispatchMenu(t, epic, cx)));
  }

  render(cx) {
    const t = theme(), state = this.state, rows = scopeEpics(state.rows, this.scope, state.context), card = this.spaceCard(t, cx);
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
      .when(Boolean(card), (el) => el.child(card))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().py(5)
        .when(state.loading, (el) => el.child(div().p(12).text_size(11.5).text_color(t.dim).child("Loading epics…")))
        .when(Boolean(state.error), (el) => el.child(div().mx(8).p(8).rounded(6).text_size(11).text_color(t.blocked).bg(t.raised).child(state.error)))
        .when(Boolean(state.coverageError), (el) => el.child(div().mx(8).p(8).rounded(6).text_size(11).text_color(t.blocked).bg(t.raised).child(`Incomplete coverage: ${state.coverageError}`)))
        .when(state.stale && state.rows.length > 0, (el) => el.child(div().mx(8).py(5).text_size(10.5).text_color(t.dim).child("Showing last successful results (stale).")))
          .when(!state.loading && !state.error && !state.coverageError && rows.length === 0, (el) => el.child(div().p(12).text_size(11.5).text_color(t.dim).child("No epics in this project.")))
         .children(rows.map((epic) => this.row(t, epic, cx))));
  }
}
