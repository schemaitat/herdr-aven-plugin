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

export function desiredChoice(choices, spaceId) { return validChoice(choices?.[spaceId]); }

export function panelCommands(choice, shown, active) {
  if (!validChoice(choice)) return [];
  if (shown && active === choice) return [{ name: "layout.hide", args: { id: "panel" } }];
  return [
    { name: "layout.select", args: { stack: "panel-body", child: choice } },
    { name: "layout.show", args: { id: "panel" } },
  ];
}
