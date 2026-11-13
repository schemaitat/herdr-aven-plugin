// Derived from Herdr 0.1.12's shipped tabs mod. This owned copy intentionally
// differs only by isolated panel state and the third Aven selector.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, spaces, panes, run, openOverlay, theme, window, layout, settings } from "herdr";
import { STORAGE_KEY, decodeChoices, desiredChoice, dispatchFolders, encodeChoices, folderKey, machineOption, panelCommands } from "./logic.js";

function find(node, id) { if (node?.id === id) return node; for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; } return null; }

export default class AvenPanelTabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.choices = decodeChoices(localStorage.getItem(STORAGE_KEY));
    this.generation = 0;
    this.dispatch = new Set();
    this.focusedSpace = "";
    this.track(cx);
    cx.timer.every(5000, (timerCx) => this.track(timerCx));
  }
  save() { localStorage.setItem(STORAGE_KEY, encodeChoices(this.choices)); }
  commands(commands) { for (const command of commands) run(command.name, command.args); }
  track(cx) {
    const space = spaces().find((entry) => entry.active) ?? null;
    const id = String(space?.id ?? "");
    if (id === this.focusedSpace) return;
    this.focusedSpace = id;
    this.refreshDispatch(space?.folder, space?.machine ?? null, cx);
  }
  refreshDispatch(folder, machine, cx) {
    const target = String(machine ?? "");
    if (!folder && !target) { this.applyDispatch(new Set(), cx); return; }
    cx.spawn(async (taskCx) => {
      let folders = new Set();
      try {
        const result = await exec("aven-dispatch", ["list", "--summary"], machineOption(machine, folder ? { cwd: folder } : {}));
        if (result.code === 0) folders = dispatchFolders(JSON.parse(result.stdout || "[]"), machine);
      } catch {}
      this.applyDispatch(folders, taskCx);
    });
  }
  applyDispatch(folders, cx) {
    const before = [...this.dispatch].sort().join("\n");
    const after = [...folders].sort().join("\n");
    if (before === after) return;
    this.dispatch = folders;
    // Re-evaluate the focused space now that dispatch knowledge arrived.
    this.space = "";
    try { cx.notify(); } catch {}
  }
  restore(space, panel, body) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id === this.space) return;
    this.space = space.id;
    const dispatched = this.dispatch.has(folderKey(space.folder, space.machine ?? null));
    const choice = desiredChoice(this.choices, space.id, dispatched);
    // A first visit stays hidden unless the space is a dispatched worktree;
    // an explicit valid saved choice always wins.
    if (!choice || choice === now) return;
    const generation = this.generation;
    this.pending = { choice, generation, until: Date.now() + 1000 };
    this.commands(panelCommands(choice, false, now));
  }
  select(choice, panel, body) {
    const shown = Boolean(panel && !panel.hidden), active = body?.active;
    this.generation += 1; this.pending = null;
    this.commands(panelCommands(choice, shown, active));
    if (this.space) { this.choices[this.space] = choice; this.save(); }
  }
  render() {
    const t = theme(), space = spaces().find((entry) => entry.active), shown = space?.tabs ?? [];
    const stop = (_event, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover((style) => style.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(action).child(label);
    const item = (tab, index) => {
      const program = panes().find((pane) => pane.tab === tab.id && pane.program?.agent)?.program ?? panes().find((pane) => pane.tab === tab.id)?.program;
      const name = /^tb\d+$/.test(tab.name) ? program?.name ?? "Terminal" : tab.name;
      return h_flex().id(`tab-${tab.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8).border(1).border_color(tab.active ? t.border : t.chrome).bg(tab.active ? t.raised : t.chrome).text_color(tab.active ? t.foreground : t.muted).hover((style) => style.bg(t.hover))
        .on_mouse_down("left", (event, cx) => { cx.stop_propagation(); this.pressed = index; if (event.click_count === 2) run("tab.rename", { id: tab.id }); })
        .on_mouse_up("left", () => { const from = this.pressed; this.pressed = null; if (from !== null && from !== index) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex((entry) => entry.id === tab.id) + 1 }); else run("tab.select", { id: tab.id }); })
        .on_mouse_down("right", (_event, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } }); })
        .when(Boolean(program?.icon), (el) => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(tab.zoomed ? `${name} Z` : name))
        .when(tab.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(tab.status === "blocked" || tab.status === "done", (el) => el.child(div().size(6).rounded(3).bg(t[tab.status])))
        .when(tab.active, (el) => el.child(div().id(`close-${tab.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_event, cx) => { cx.stop_propagation(); run("tab.close", { id: tab.id }); }).child(svg("mods/aven-panel-tabs/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0)) : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body"); this.restore(space, panel, body);
    const selector = (id, label, icon) => { const on = panel && !panel.hidden && body?.active === id; return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((style) => style.bg(t.hover)).on_mouse_down("left", stop).on_click(() => this.select(id, panel, body)).child(svg(icon).size(14)).child(label); };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border).on_mouse_up("left", () => { this.pressed = null; }).on_scroll_wheel((event) => { if (Math.abs(event.delta.y) >= 1) run(event.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(selector("files", "Files", "mods/aven-panel-tabs/file.svg")).child(selector("changes", "Changes", "mods/aven-panel-tabs/changes.svg")).child(selector("aven", "Aven", "mods/aven-panel-tabs/aven.svg"))
      .when(w?.buttons, (el) => el.child(button("minimize", w.platform === "windows" ? svg("mods/aven-panel-tabs/win-min.svg").size(16) : "−", () => run("window.minimize"))).child(button("maximize", w.platform === "windows" ? svg(`mods/aven-panel-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize"))).child(button("close-window", w.platform === "windows" ? svg("mods/aven-panel-tabs/win-close.svg").size(16) : svg("mods/aven-panel-tabs/close.svg").size(13), () => run("window.close"))));
  }
}
