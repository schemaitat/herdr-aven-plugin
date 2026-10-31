// Aven task launcher for Herdr. This mod only changes what the person sees:
// it starts a dedicated herdr-core terminal and reveals it. Closing it never
// ends dispatched work, and a missing app never affects dispatch.
import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, focused, hc, props, run, theme } from "herdr";

const base = (path) => (path ?? "").replace(/\/+$/, "").split("/").pop() || path || "~";

export default class AvenTasks extends View {
  init(_props, cx) {
    this.cx = cx;
    this.error = "";
    this.live = [];
    this.closed = false;
    this.refreshing = false;
    this.cwd = focused()?.cwd ?? null;
    this.refresh(cx);
    this.tick(cx);
  }

  close() {
    this.closed = true;
    closeOverlay(props().overlay);
  }

  tick(cx) {
    cx.timer.after(2000, () => {
      if (this.closed) return;
      void this.refresh(cx);
      this.tick(cx);
    });
  }

  async refresh(cx) {
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
    if (!this.closed) cx.notify();
  }

  reuse(kind, folder) {
    const prefix = kind === "compose" ? "aven-add-" : "aven-tui-";
    return this.live.find(terminal => terminal.state === "live" && terminal.cwd === folder && String(terminal.name ?? "").startsWith(prefix));
  }

  async reveal(terminal) {
    this.close();
    run("terminal.peek", { terminal });
  }

  async launch(kind, cx) {
    const folder = this.cwd;
    if (!folder) {
      this.error = "No focused folder; open a terminal first.";
      cx.notify();
      return;
    }
    const existing = this.reuse(kind, folder);
    if (existing) {
      this.reveal(existing.address);
      return;
    }
    const name = `${kind === "compose" ? "aven-add" : "aven-tui"}-${Date.now().toString(36)}`;
    const command = kind === "compose"
      ? ["run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", folder, "--", "aven", "tui", "-p", "--add-task-only"]
      : ["run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name, "--cwd", folder, "--", "aven", "tui", "-p"];
    try {
      const result = await hc(command);
      if (result.code !== 0) throw new Error(result.stderr.trim() || "could not start aven");
      this.reveal(JSON.parse(result.stdout).address);
    } catch (error) {
      this.error = String(error?.message ?? error);
      cx.notify();
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
      .child(h_flex().px(10).pb(6).items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Aven tasks")).child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(this.action("Open aven", "tui", () => this.launch("tui", this.cx)))
      .child(this.action("Add a task", "composer", () => this.launch("compose", this.cx)))
      .child(this.action("Refresh terminals", "live", () => this.refresh(this.cx)))
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
        .on_click(() => this.reveal(terminal.address))
        .child(div().flex_1().truncate().text_color(t.foreground).child(terminal.name || terminal.address))
        .child(div().text_size(11).text_color(t.dim).child(`${terminal.agent ?? ""} ${base(terminal.cwd)}`)))));
  }
}
