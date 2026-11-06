// Aven task launcher for Herdr. This mod only changes what the person sees:
// it starts a dedicated herdr-core terminal and reveals it. Closing it never
// ends dispatched work, and a missing app never affects dispatch.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, exec, focused, hc, nextCommand, props, run, terminals, theme } from "herdr";

const base = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop() || path || "~";
// herdr-core returns a new address before herdr-app has adopted the terminal.
// Probe the peek for a bounded time instead of revealing too early.
const READY_TIMEOUT_MS = 3000;
const READY_POLL_MS = 50;
// The overlay can take focus while it is attaching; retry after that handoff.
const FOCUS_RETRY_MS = 600;

export default class AvenTasks extends View {
  init(_props, cx) {
    this.cx = cx;
    this.error = "";
    this.live = [];
    this.closed = false;
    this.refreshing = false;
    this.cwd = focused()?.cwd ?? null;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(FOCUS_RETRY_MS, () => { if (!this.closed) this.handle.focus(); });
    this.refresh();
    this.tick(cx);
    this.commands(cx);
  }

  commands(cx) {
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) return;
        const name = String(command).split(".").pop();
        if (name === "open") await this.launch("tui");
        else if (name === "add") await this.launch("compose");
        else if (name === "kanban") this.openKanban();
        else if (name === "refresh") await this.refresh();
        else if (name === "close") this.close();
        else cx.notify();
      }
    });
  }

  close() {
    this.closed = true;
    closeOverlay(props().overlay);
  }

  openKanban() {
    this.close();
    run("mod.open", { name: "aven-kanban" });
  }

  tick(cx) {
    cx.timer.after(2000, () => {
      if (this.closed) return;
      void this.refresh();
      this.tick(cx);
    });
  }

  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const result = await hc(["ls", "--json"]);
      if (result.code !== 0) throw new Error("herdr-core is unavailable");
      this.live = JSON.parse(result.stdout).terminals ?? [];
      this.error = "";
    } catch (error) {
      this.error = String(error?.message ?? error);
    } finally {
      this.refreshing = false;
    }
    if (!this.closed) this.cx.notify();
  }

  reuse(kind, folder) {
    const prefix = kind === "compose" ? "aven-add-" : "aven-tui-";
    const matches = terminal => terminal.state === "live" && terminal.cwd === folder && String(terminal.name ?? "").startsWith(prefix);
    return terminals().find(matches) ?? this.live.find(matches);
  }

  // A terminal started by `hc run` is live in the core before herdr-app can
  // peek it. Probe through the CLI (a failed CLI call stays on stderr instead
  // of surfacing the terminal-not-found error), then close the overlay over
  // the revealed terminal. If probing is unavailable, reveal once directly so
  // real failures remain visible.
  async reveal(terminal) {
    const address = typeof terminal === "string" ? terminal : terminal?.address;
    if (!address) return;
    await this.revealReady(address);
    this.close();
    // The CLI probe confirms that Herdr adopted the terminal, but does not
    // transfer this overlay's in-app keyboard focus. Repeat the reveal through
    // the app command so the Aven TUI owns input as it becomes visible.
    run("terminal.peek", { terminal: address });
  }

  async revealReady(address) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      try {
        const result = await exec("herdr-app", ["do", "terminal.peek", "--terminal", address]);
        if (result.code === 0) return true;
      } catch {
        return false;
      }
      if (Date.now() >= deadline) return false;
      await this.cx.sleep(READY_POLL_MS);
    }
  }

  async launch(kind) {
    const folder = this.cwd;
    if (!folder) {
      this.error = "No focused folder; open a terminal first.";
      this.cx.notify();
      return;
    }
    const existing = this.reuse(kind, folder);
    if (existing) {
      await this.reveal(existing.address);
      return;
    }
    const name = `${kind === "compose" ? "aven-add" : "aven-tui"}-${Date.now().toString(36)}`;
    const command = kind === "compose"
      ? ["run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", folder, "--", "aven", "tui", "-p", "--add-task-only"]
      : ["run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", folder, "--", "aven", "tui", "-p"];
    try {
      const result = await hc(command);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "could not start aven");
      await this.reveal(JSON.parse(result.stdout).address);
    } catch (error) {
      this.error = String(error?.message ?? error);
      this.cx.notify();
    }
  }

  action(label, hint, onClick) {
    const t = theme();
    return h_flex()
      .mx(6)
      .px(10)
      .h(34)
      .items_center()
      .rounded(7)
      .gap(8)
      .cursor_pointer()
      .hover((style) => style.bg(t.hover))
      .on_click(onClick)
      .child(div().flex_1().text_color(t.foreground).child(label))
      .child(div().text_size(11).text_color(t.dim).child(hint));
  }

  render() {
    const t = theme();
    const dispatch = this.live.filter(terminal => terminal.state === "live").slice(0, 8);
    return v_flex()
      .id("aven-tasks")
      .w_full()
      .p(12)
      .gap(4)
      .bg(t.popover)
      .text_size(13)
      .track_focus(this.handle)
      // Layout completes after the overlay attaches and can take focus. Reclaim
      // it on the first size notification so its key handlers work immediately.
      .on_size_change((_size, _cx) => { if (!this.closed) this.handle.focus(); })
      .on_key_down((event, cx) => {
        const key = event.key;
        if (key === "escape") this.close();
        else if (key === "o") this.launch("tui");
        else if (key === "a") this.launch("compose");
        else if (key === "k") this.openKanban();
        else if (key === "r") this.refresh();
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().px(10).pb(6).items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Aven tasks")).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(this.action("Open aven", "o", () => this.launch("tui")))
      .child(this.action("Add a task", "a", () => this.launch("compose")))
      .child(this.action("Kanban board", "k", () => this.openKanban()))
      .child(this.action("Refresh terminals", "r", () => this.refresh()))
      .when(this.error, el => el.child(div().px(10).py(6).text_size(11).text_color(t.blocked).child(this.error)))
      .when(dispatch.length > 0, el => el.child(h_flex().px(10).pt(8).pb(3).text_size(11).font_semibold().text_color(t.dim).child("Live terminals")).children(dispatch.map(terminal => h_flex()
        .mx(6)
        .px(10)
        .h(30)
        .items_center()
        .rounded(7)
        .gap(8)
        .cursor_pointer()
        .hover((style) => style.bg(t.hover))
        .on_click(() => this.reveal(terminal))
        .child(div().flex_1().truncate().text_color(t.foreground).child(terminal.name || terminal.address))
        .child(div().text_size(11).text_color(t.dim).child(`${terminal.agent ?? ""} ${base(terminal.cwd)}`)))));
  }
}
