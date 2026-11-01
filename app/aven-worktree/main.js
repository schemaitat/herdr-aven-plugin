// The Aven epic or task behind a dispatcher worktree.
//
// The dispatcher opens one copy of this panel beside the worktree's agent
// terminal and passes { ref, space }. When opened anywhere else the panel
// resolves the worktree from the focused space, its branch, or the persisted
// dispatcher attempt. It only reads Aven and aven-dispatch; it never mutates
// either, and a missing Aven, dispatcher store or worktree degrades to a small
// explanatory card instead of an error.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, focused, hc, panes, props, run, spaces, terminals, theme } from "herdr";

const REF = /^([A-Z][A-Z0-9]*-\S+)(?:\s|$)/;
const STATUS = {
  inbox: "Inbox",
  backlog: "Backlog",
  todo: "Todo",
  active: "Active",
  done: "Done",
  canceled: "Canceled",
};
const PHASE_GLYPH = { done: "✓", active: "●", canceled: "–", todo: "○", backlog: "○", inbox: "○" };

const label = (status) => STATUS[status] ?? (status ? status[0].toUpperCase() + status.slice(1) : "Unknown");
const base = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop() || "";

function taskTone(t, status, blocked) {
  if (blocked) return t.blocked;
  if (status === "done") return t.done;
  if (status === "active") return t.working;
  if (status === "canceled") return t.dim;
  return t.muted;
}

function dispatchTone(t, state) {
  if (!state) return t.dim;
  if (/running|waiting|pending/.test(state)) return t.working;
  if (/review/.test(state)) return t.accent;
  if (/complete|done/.test(state)) return t.done;
  if (/fail|error|interrupt|block/.test(state)) return t.blocked;
  return t.muted;
}

function phaseGlyph(t, status) {
  return { glyph: PHASE_GLYPH[status] ?? "○", color: taskTone(t, status, false) };
}

function parse(result, what) {
  if (result.code !== 0) {
    throw new Error(`${what}: ${(result.stderr || "").trim() || `exit ${result.code}`}`);
  }
  return JSON.parse(result.stdout);
}

function refOf(space) {
  return REF.exec(String(space?.name ?? ""))?.[1] ?? "";
}

function attemptTerminals(attempt) {
  const found = [];
  const add = (terminal, role) => {
    if (terminal?.address) found.push({ address: terminal.address, role: role || terminal.role || "", name: terminal.name || "" });
  };
  add(attempt?.terminal, "build");
  add(attempt?.coordinator_terminal, "coordinator");
  add(attempt?.babysitter_terminal, "babysitter");
  for (const [role, terminal] of Object.entries(attempt?.terminals ?? {})) add(terminal, role);
  for (const phase of attempt?.phases ?? []) add(phase.terminal, phase.task_ref);
  const seen = new Set();
  return found.filter((terminal) => {
    if (seen.has(terminal.address)) return false;
    seen.add(terminal.address);
    return true;
  });
}

export default class AvenWorktree extends View {
  init(_props, cx) {
    this.state = { loading: true };
    this.refreshing = false;
    this.refresh(cx);
    // Aven status changes through notes, phases and reviews outside this
    // window, so the card follows the store rather than the terminal.
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  notify(cx) {
    try {
      cx?.notify();
    } catch {
      // The build was replaced or closed; its next timer tick ends the loop.
    }
  }

  space() {
    const all = spaces();
    const pinned = props()?.space;
    if (pinned) {
      const match = all.find((space) => space.id === pinned);
      if (match) return match;
    }
    const pane = props()?.pane;
    if (pane) {
      const tab = panes().find((entry) => entry.pane === pane)?.tab;
      const match = all.find((space) => (space.tabs ?? []).some((entry) => entry.id === tab));
      if (match) return match;
    }
    const current = focused()?.space;
    return all.find((space) => space.id === current) ?? all.find((space) => space.active) ?? null;
  }

  attemptFor(attempts, { folder, branch, root, task }) {
    return (
      attempts
        .filter((attempt) => {
          if (folder && attempt.worktree === folder) return true;
          if (branch && attempt.branch === branch) return true;
          if (root && attempt.task_ref === root) return true;
          if (task && attempt.task_ref === task) return true;
          return (attempt.phases ?? []).some(
            (phase) => (task && phase.task_ref === task) || (folder && phase.worktree === folder),
          );
        })
        .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0] ?? null
    );
  }

  async refresh(cx) {
    if (this.refreshing) return;
    this.refreshing = true;
    let folder = "";
    try {
      const space = this.space();
      folder = space?.folder ?? "";
      // The persisted attempts and the Aven store are machine-local. A missing
      // worktree must not hide the task, so a failed cwd falls back to the
      // app's own working directory.
      const run = async (program, args) => {
        if (folder) {
          try {
            const local = await exec(program, args, { cwd: folder });
            if (local.code === 0) return local;
          } catch {
            // A missing worktree falls through to the app's own directory.
          }
        }
        return await exec(program, args);
      };
      const attempts = parse(await run("aven-dispatch", ["list"]), "dispatcher list");
      const ref = String(props()?.ref ?? "").trim() || refOf(space) || this.refOfAttempt(attempts, folder);
      if (!ref) {
        this.state = { missing: true, folder };
        return;
      }
      const task = parse(await run("aven", ["show", ref, "--json"]), "aven show");
      let root = task;
      if (!task.is_epic && task.epic_parent?.ref) {
        root = parse(await run("aven", ["show", task.epic_parent.ref, "--json"]), "aven show");
      }
      const attempt = this.attemptFor(attempts, {
        folder,
        branch: space?.branch,
        root: root?.ref,
        task: task.ref,
      });
      this.state = { task, root, attempt, folder, branch: space?.branch ?? "", at: Date.now() };
    } catch (error) {
      this.state = { error: String(error?.message ?? error), folder };
    } finally {
      this.refreshing = false;
      this.notify(cx);
    }
  }

  refOfAttempt(attempts, folder) {
    if (!folder) return "";
    return attempts.find((attempt) => attempt.worktree === folder)?.task_ref ?? "";
  }

  liveTerminal(attempt, folder) {
    const all = terminals();
    return attemptTerminals(attempt)
      .map((terminal) => ({ ...terminal, core: all.find((entry) => entry.address === terminal.address) }))
      .find((terminal) => terminal.core && (!folder || terminal.core.cwd === folder));
  }

  async openAven(cx) {
    const folder = this.state.folder || this.space()?.folder;
    if (!folder) return;
    const existing = terminals().find(
      (terminal) => terminal.state === "live" && terminal.cwd === folder && String(terminal.name ?? "").startsWith("aven-tui-"),
    );
    if (existing) {
      run("terminal.peek", { terminal: existing.address });
      return;
    }
    try {
      const name = `aven-tui-${Date.now().toString(36)}`;
      const result = await hc([
        "run", "--bg", "--json", "--no-parent", "--outlive-parent",
        "--name", name, "--cwd", folder, "--", "aven", "tui", "-p",
      ]);
      if (result.code !== 0) throw new Error((result.stderr || "").trim() || "could not start aven");
      run("terminal.peek", { terminal: JSON.parse(result.stdout).address });
    } catch (error) {
      this.state = { ...this.state, error: String(error?.message ?? error) };
      this.notify(cx);
    }
  }

  async openInspector(cx) {
    const folder = this.state.folder || this.space()?.folder;
    if (!folder) return;
    const existing = terminals().find(
      (terminal) => terminal.state === "live" && terminal.cwd === folder && String(terminal.name ?? "").startsWith("aven-inspector-"),
    );
    if (existing) {
      run("terminal.peek", { terminal: existing.address });
      return;
    }
    try {
      const name = `aven-inspector-${Date.now().toString(36)}`;
      const result = await hc([
        "run", "--bg", "--json", "--no-parent", "--outlive-parent",
        "--name", name, "--cwd", folder, "--", "aven-dispatch", "tui",
      ]);
      if (result.code !== 0) throw new Error((result.stderr || "").trim() || "could not start the inspector");
      run("terminal.peek", { terminal: JSON.parse(result.stdout).address });
    } catch (error) {
      this.state = { ...this.state, error: String(error?.message ?? error) };
      this.notify(cx);
    }
  }

  status(t, status, blocked) {
    return h_flex()
      .gap(5)
      .flex_none()
      .items_center()
      .child(div().size(6).rounded(3).bg(taskTone(t, status, blocked)))
      .child(div().text_size(10.5).text_color(taskTone(t, status, blocked)).child(label(status)));
  }

  section(t, text) {
    return div().pt(2).text_size(10).font_semibold().text_color(t.dim).child(text.toUpperCase());
  }

  button(t, id, text, onClick) {
    return h_flex()
      .id(`aven-worktree-${id}`)
      .h(28)
      .px(9)
      .rounded(6)
      .items_center()
      .cursor_pointer()
      .bg(t.raised)
      .text_color(t.muted)
      .hover((style) => style.bg(t.hover).text_color(t.foreground))
      .on_click(onClick)
      .child(div().text_size(11.5).child(text));
  }

  progress(t, done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    return h_flex()
      .gap(8)
      .items_center()
      .child(div().flex_1().min_w(0).h(4).rounded(2).bg(t.border).overflow_hidden()
        .child(div().h_full().w(`${pct}%`).rounded(2).bg(t.accent)))
      .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`${done}/${total}`));
  }

  epic(t) {
    const { root, task } = this.state;
    if (!root?.is_epic || !(root.epic_children ?? []).length) return null;
    const children = root.epic_children;
    const done = children.filter((child) => child.status === "done").length;
    return v_flex()
      .gap(6)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_color(t.accent).child("◆"))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(root.ref))
        .child(this.status(t, root.status, root.blocked_by > 0)))
      .child(div().text_size(12).text_color(t.muted).child(root.title))
      .child(this.progress(t, done, children.length))
      .when(task.ref !== root.ref, (el) => el.child(
        v_flex()
          .gap(2)
          .pt(4)
          .child(h_flex().gap(6).items_center()
            .child(div().flex_none().text_color(t.accent).child("▸"))
            .child(div().flex_1().min_w(0).truncate().text_size(12).font_semibold().text_color(t.foreground).child(task.ref))
            .child(this.status(t, task.status, task.blocked_by > 0)))
          .child(div().text_size(12).text_color(t.muted).child(task.title)),
      ));
  }

  taskBlock(t) {
    const task = this.state.task;
    return v_flex()
      .gap(3)
      .child(h_flex().gap(6).items_center()
        .child(div().flex_none().text_color(t.accent).child(task.is_epic ? "◆" : "●"))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(task.ref))
        .child(this.status(t, task.status, task.blocked_by > 0)))
      .child(div().text_size(12).text_color(t.muted).child(task.title));
  }

  phases(t) {
    const children = this.state.root?.epic_children ?? [];
    if (!children.length) return null;
    return v_flex()
      .gap(2)
      .child(this.section(t, "Phases"))
      .children(children.map((phase) => {
        const mark = phaseGlyph(t, phase.status);
        const current = phase.ref === this.state.task?.ref;
        return h_flex()
          .id(`aven-phase-${phase.ref}`)
          .h(26)
          .px(5)
          .gap(7)
          .rounded(5)
          .items_center()
          .when(current, (el) => el.bg(t.selected))
          .child(div().w(12).flex_none().text_color(mark.color).child(mark.glyph))
          .child(div().flex_none().text_size(11).text_color(current ? t.foreground : t.dim).child(phase.ref))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(current ? t.foreground : t.muted).child(phase.title));
      }));
  }

  dispatch(t) {
    const { attempt, task, folder } = this.state;
    if (!attempt) return null;
    const phase = (attempt.phases ?? []).find((entry) => entry.task_ref === task.ref);
    const live = this.liveTerminal(attempt, folder);
    const model = String(attempt.model ?? "").split("/").pop();
    const agent = [attempt.agent, model].filter(Boolean).join(" · ");
    return v_flex()
      .gap(5)
      .child(this.section(t, "Dispatch"))
      .child(h_flex().gap(7).items_center()
        .child(div().size(6).rounded(3).flex_none().bg(dispatchTone(t, attempt.state)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(attempt.state || "unknown"))
        .when(Boolean(agent), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(agent))))
      .when(Boolean(attempt.execution_mode), (el) => el.child(
        h_flex().gap(6).text_size(11).text_color(t.dim)
          .child(div().flex_none().child(attempt.execution_mode))
          .when(Boolean(phase?.state), (row) => row.child(div().flex_none().child(`· ${phase.state}`)))
          .when(Boolean(attempt.babysitter), (row) => row.child(div().flex_none().child("· babysitter"))),
      ))
      .when(Boolean(live), (el) => el.child(
        h_flex()
          .id("aven-worktree-terminal")
          .h(26)
          .px(5)
          .gap(7)
          .rounded(5)
          .items_center()
          .cursor_pointer()
          .hover((style) => style.bg(t.hover))
          .on_click(() => run("terminal.peek", { terminal: live.address }))
          .child(div().size(6).rounded(3).flex_none().bg(live.core.status === "blocked" ? t.blocked : live.core.status === "working" ? t.working : t.idle))
          .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(live.role || live.name || live.address))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(live.core.status || live.core.state || "live")),
      ));
  }

  details(t) {
    const { task, folder, branch } = this.state;
    const facts = [
      ["Worktree", base(folder)],
      ["Branch", branch || ""],
      ["Priority", task?.priority && task.priority !== "none" ? task.priority : ""],
      ["Labels", (task?.labels ?? []).join(", ")],
    ].filter(([, value]) => value);
    if (!facts.length) return null;
    return v_flex()
      .gap(4)
      .child(this.section(t, "Worktree"))
      .children(facts.map(([key, value]) => h_flex()
        .gap(8)
        .text_size(11)
        .child(div().w(58).flex_none().text_color(t.dim).child(key))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(value))));
  }

  empty(t, text, detail) {
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(6)
      .p(16)
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(text))
      .child(div().text_size(11.5).text_color(t.dim).child(detail));
  }

  render() {
    const t = theme();
    const state = this.state;
    const epic = state.task ? this.epic(t) : null;
    const taskBlock = state.task && !(state.root?.is_epic && (state.root.epic_children ?? []).length)
      ? this.taskBlock(t)
      : null;
    const phases = state.task ? this.phases(t) : null;
    const dispatch = state.task ? this.dispatch(t) : null;
    const details = state.task ? this.details(t) : null;
    return v_flex()
      .id("aven-worktree")
      .size_full()
      .min_h(0)
      .bg(t.background)
      .text_size(12.5)
      .text_color(t.foreground)
      .child(h_flex()
        .h(36)
        .px(11)
        .gap(7)
        .flex_none()
        .items_center()
        .child(div().flex_none().text_color(t.accent).child("◆"))
        .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.dim).child("AVEN"))
        .child(div().flex_1())
        .child(div()
          .id("aven-worktree-refresh")
          .size(24)
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .rounded(6)
          .cursor_pointer()
          .hover((style) => style.bg(t.hover).text_color(t.foreground))
          .on_click((_event, cx) => this.refresh(cx))
          .child(div().text_size(13).text_color(t.dim).child("⟳"))))
      .child(div().h(1).flex_none().w_full().bg(t.border))
      .child(v_flex()
        .flex_1()
        .min_h(0)
        .p(11)
        .gap(12)
        .overflow_y_scrollbar()
        .when(state.loading, (el) => el.child(this.empty(t, "Loading Aven task…", "Reading the local Aven store.")))
        .when(state.missing, (el) => el.child(this.empty(t, "No Aven task for this worktree",
          "Open a dispatcher worktree or pass a task ref.")))
        .when(state.error, (el) => el.child(v_flex()
          .gap(5)
          .child(div().text_size(12).font_semibold().text_color(t.blocked).child("Aven is unavailable"))
          .child(div().text_size(11.5).text_color(t.dim).child(state.error))))
        .when(Boolean(epic), (el) => el.child(epic))
        .when(Boolean(taskBlock), (el) => el.child(taskBlock))
        .when(Boolean(phases), (el) => el.child(phases))
        .when(Boolean(dispatch), (el) => el.child(dispatch))
        .when(Boolean(details), (el) => el.child(details))
        .child(h_flex()
          .gap(6)
          .pt(2)
          .child(this.button(t, "open", "Open Aven", (_event, cx) => this.openAven(cx)))
          .child(this.button(t, "inspect", "Inspector", (_event, cx) => this.openInspector(cx))))
      );
  }
}
