export const PANEL_CHOICES = ["files", "changes", "aven"];
export const STORAGE_KEY = "herdr-aven-plugin.aven-panel-tabs.v1";

export function validChoice(value) { return PANEL_CHOICES.includes(value) ? value : null; }

export function decodeChoices(text) {
  try {
    const parsed = JSON.parse(text ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).map(([space, choice]) => [space, validChoice(choice)]));
  } catch { return {}; }
}

export function encodeChoices(choices) {
  return JSON.stringify(Object.fromEntries(Object.entries(choices).filter(([, choice]) => validChoice(choice))));
}

export function normalizeFolder(value) { return String(value ?? "").replace(/\/+$/, ""); }

export function machineOption(machine, extra = {}) {
  const target = String(machine ?? "");
  return target ? { ...extra, on: target } : extra;
}

// A remote worktree can share a path with this computer's. Key the dispatch set
// by machine as well as folder so selection never crosses machines.
export function folderKey(folder, machine = null) {
  const value = normalizeFolder(folder);
  if (!value) return "";
  return machine ? `${machine}\u0000${value}` : value;
}

// A worktree is dispatched when a persisted attempt or one of its phases names
// this checkout. Ordinary project spaces stay on their explicit choice only.
export function dispatchFolders(attempts = [], machine = null) {
  const folders = new Set();
  for (const attempt of attempts ?? []) {
    const values = [attempt?.worktree, ...(attempt?.phases ?? []).map((phase) => phase?.worktree)];
    for (const value of values) {
      const key = folderKey(value, machine);
      if (key) folders.add(key);
    }
  }
  return folders;
}

export function desiredChoice(choices, spaceId, dispatched = false) {
  return validChoice(choices?.[spaceId]) ?? (dispatched ? "aven" : null);
}

export function panelCommands(choice, shown, active) {
  if (!validChoice(choice)) return [];
  if (shown && active === choice) return [{ name: "layout.hide", args: { id: "panel" } }];
  return [
    { name: "layout.select", args: { stack: "panel-body", child: choice } },
    { name: "layout.show", args: { id: "panel" } },
  ];
}
