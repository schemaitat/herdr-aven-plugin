// Pure Aven-panel contracts. Kept independent of GPUI so query and identity
// behavior can be exercised with Node fixtures.
export const LIMIT = 500;
// The Board/Kanban project chip palette. Each project keeps one colour so the
// panel rows and the Kanban project chips agree without shared state.
export const PROJECT_TONES = [
  { fg: "#e0707f", bg: "#3b1d24" },
  { fg: "#3ec9b4", bg: "#11302d" },
  { fg: "#f0a050", bg: "#3a2410" },
  { fg: "#a690e8", bg: "#2a2245" },
  { fg: "#e6c35c", bg: "#352c10" },
  { fg: "#6fb3f2", bg: "#152a40" },
  { fg: "#e88cc8", bg: "#3a1a30" },
  { fg: "#8fd18a", bg: "#1c321c" },
];
export const DEFAULT_PROJECT_TONE = { fg: "#c8c8cc", bg: "#242328" };
export const DISPATCH_ACTIONS = [
  { id: "dispatch", detailKey: "d", terminalKey: "d", label: "z d", description: "Dispatch task" },
  { id: "plan-implement", detailKey: "s", terminalKey: "s", label: "z s", description: "Plan then implement" },
  { id: "plan", detailKey: "p", terminalKey: "p", label: "z p", description: "Create implementation plan" },
  { id: "implement", detailKey: "i", terminalKey: "i", label: "z i", description: "Implement existing plan" },
  { id: "reset", detailKey: "r", terminalKey: "r", label: "z r", description: "Reset dispatcher execution" },
  { id: "plan-implement-babysitter", detailKey: "x", terminalKey: "x", label: "z x", description: "Plan then implement with babysitter" },
  { id: "implement-babysitter", detailKey: "b", terminalKey: "b", label: "z b", description: "Implement with babysitter" },
];

export function projectArgs(workspace) {
  return ["project", "list", "--workspace", workspace, "--limit", String(LIMIT), "--json"];
}

export function openArgs(workspace, project) {
  return ["list", "--workspace", workspace, "--project", project, "--open", "--epics", "--limit", String(LIMIT), "--json"];
}

// `--upcoming` cannot be combined with `--epics`, so callers filter it here.
export function upcomingArgs(workspace, project) {
  return ["list", "--workspace", workspace, "--project", project, "--upcoming", "--limit", String(LIMIT), "--json"];
}

// Omitting --project lets Aven infer the project from the selected space's
// Git root. This keeps All scoped to (for example) HAP, not every workspace
// project, while still including every space in that project.
export function inferredEpicArgs(workspace) {
  return ["list", "--workspace", workspace, "--epics", "--limit", String(LIMIT), "--json"];
}

export function inferredUpcomingArgs(workspace) {
  return ["list", "--workspace", workspace, "--upcoming", "--limit", String(LIMIT), "--json"];
}

export function canonicalId(row) {
  return String(row?.id ?? row?.canonical_id ?? row?.ref ?? "").trim();
}

export function qualifiedRef(row, project) {
  const ref = String(row?.ref ?? row?.display_ref ?? "").trim();
  return ref || (project && row?.ref_suffix ? `${project}-${row.ref_suffix}` : "");
}

export function normalizeEpic(row, project, workspace) {
  if (!row || row.deleted || !row.is_epic || row.status === "done" || row.status === "canceled") return null;
  const id = canonicalId(row);
  const ref = qualifiedRef(row, project);
  if (!id || !ref) return null;
  return {
    id, ref, project: String(row.project?.key ?? row.project ?? project ?? ""), workspace,
    title: String(row.title ?? "Untitled epic"), status: String(row.status),
    created_at: typeof row.created_at === "string" ? row.created_at : "",
  };
}

function dateValue(value) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortEpics(rows) {
  return [...rows].sort((a, b) => {
    const ad = dateValue(a.created_at), bd = dateValue(b.created_at);
    if (ad !== null && bd !== null && ad !== bd) return bd - ad;
    if (ad !== null && bd === null) return -1;
    if (ad === null && bd !== null) return 1;
    return a.id.localeCompare(b.id);
  });
}

export function mergeProjectRows({ workspace, project, open = [], upcoming = [] }) {
  const rows = new Map();
  for (const raw of [...open, ...upcoming]) {
    const row = normalizeEpic(raw, project, workspace);
    if (row && !rows.has(row.id)) rows.set(row.id, row);
  }
  return sortEpics([...rows.values()]);
}

// A project colour is decoration, never identity: it is derived from the name
// with the same hash the Kanban board uses, so one project reads the same in
// both surfaces. An absent project stays neutral instead of borrowing a colour.
export function projectTone(name) {
  const label = String(name ?? "").trim();
  if (!label) return DEFAULT_PROJECT_TONE;
  let hash = 0;
  for (const character of label) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PROJECT_TONES[hash % PROJECT_TONES.length] ?? DEFAULT_PROJECT_TONE;
}

// Sidebar descriptions are display text, not Markdown input. Keep the first
// meaningful paragraph for a collapsed row and a lightly cleaned multi-line
// body for the accordion, both bounded so a long description never takes over
// the card.
function cleanDescriptionLine(line) {
  return String(line ?? "")
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^\s*>\s?/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clampDescription(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function descriptionSnippet(description, limit = 160) {
  const lines = String(description ?? "").replace(/\r\n?/g, "\n").split("\n");
  const parts = [];
  for (const line of lines) {
    if (/^\s*#{1,6}\s+/.test(line)) continue;
    const text = cleanDescriptionLine(line);
    if (!text) {
      if (parts.length) break;
      continue;
    }
    parts.push(text);
  }
  return clampDescription(parts.join(" ").trim(), limit);
}

export function descriptionBody(description, limit = 1600) {
  const lines = String(description ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (/^\s*#{1,6}\s+/.test(line)) return cleanDescriptionLine(line);
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return `• ${cleanDescriptionLine(line)}`;
    return cleanDescriptionLine(line);
  });
  return clampDescription(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), limit);
}

// LLM summaries share one contract with `aven-dispatch describe`: at most
// three short bullet lines, produced only for long descriptions. Short text
// keeps its existing raw presentation.
export const SUMMARY_LABEL = "LLM SUMMARY";
export const SUMMARY_MIN_CHARS = 100;
export const SUMMARY_MAX_BULLETS = 3;
export const SUMMARY_LIMIT = 600;
export const SUMMARY_BULLET_LIMIT = 180;
export const SUMMARY_CARD_LIMIT = 120;

function normalizedDescription(description) {
  return String(description ?? "").replace(/\r\n?/g, "\n").trim();
}

// 32-bit FNV-1a over UTF-16 code units, matching the Rust producer. Used only
// for the stale hint; a mismatch never hides a summary.
export function summaryDigest(description) {
  let hash = 0x811c9dc5;
  const text = normalizedDescription(description);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash ^ text.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function summaryNeeded(description) {
  return [...normalizedDescription(description)].length > SUMMARY_MIN_CHARS;
}

function cleanBullet(line, limit) {
  const text = String(line ?? "")
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clampDescription(text, limit);
}

// Split stored summary text into at most three plain bullet lines. This also
// tolerates old one-paragraph summaries and Markdown emphasis.
export function summaryLines(text, limit = SUMMARY_MAX_BULLETS, bulletLimit = SUMMARY_BULLET_LIMIT) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => cleanBullet(line, bulletLimit))
    .filter(Boolean)
    .slice(0, limit);
}

export function storedSummary(metadata, description) {
  const lines = summaryLines(metadata?.["summary.llm"]);
  if (!lines.length) return null;
  const digest = String(metadata?.["summary.llm.digest"] ?? "").trim();
  const stale = Boolean(digest) && digest !== summaryDigest(description);
  return { text: lines.join("\n"), lines, stale };
}

// A task summary is available only when the description is long enough and the
// stored LLM summary exists. `cardSummary` bounds each line for a card surface.
export function taskSummary(task) {
  if (!summaryNeeded(task?.description)) return null;
  const summary = storedSummary(task?.metadata, task?.description);
  return summary ? { ...summary, label: SUMMARY_LABEL } : null;
}

export function cardSummary(task) {
  const summary = taskSummary(task);
  if (!summary) return null;
  const lines = summaryLines(summary.text, SUMMARY_MAX_BULLETS, SUMMARY_CARD_LIMIT);
  return { ...summary, text: lines.join(" · "), lines };
}

export function mergeCoverage(results) {
  const rows = new Map();
  const errors = [];
  for (const result of results) {
    if (result.error) { errors.push(`${result.project}: ${result.error}`); continue; }
    for (const row of result.rows ?? []) if (!rows.has(row.id)) rows.set(row.id, row);
  }
  return { rows: sortEpics([...rows.values()]), coverageError: errors.join("; ") };
}

// `aven show --full --json` wraps the task and its long text fields. Normalize
// it to the task shape the panel uses and keep the description and metadata
// (the LLM summary contract) alongside it.
export function fullDetail(payload) {
  const task = payload?.task ?? payload;
  if (!task || typeof task !== "object") return task;
  const detail = { ...task };
  if (payload?.description) detail.description = String(payload.description);
  if (payload?.metadata && typeof payload.metadata === "object") detail.metadata = payload.metadata;
  return detail;
}

function terminalHash(value) {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0").slice(0, 4)}`;
}

export function scopeEpics(rows, scope, context) {
  if (scope !== "space") return rows;
  const rootId = context?.kind === "dispatch" ? canonicalId(context.root) : "";
  // A normal project/root space may not belong to a dispatcher attempt. The
  // caller already queried epics from that space's Git project, so keep those
  // rows instead of making Space appear empty. Dispatched worktrees stay pinned
  // to their owning root epic.
  return rootId ? rows.filter((row) => canonicalId(row) === rootId) : rows;
}

export function terminalName(workspace, epicId) {
  // Herdr terminal names are limited to 32 chars. Keep a stable, compact
  // per-workspace/task prefix so existing terminals can still be reused.
  return `aven-e-${terminalHash(`${workspace}\u0000${epicId}`)}-`;
}

export function terminalIdentity(workspace, epicId) {
  return `${workspace}\u0000${epicId}`;
}

export function launchArgs({ workspace, epic, cwd, name }) {
  const cwdArgs = cwd ? ["--cwd", cwd] : [];
  return ["run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name,
    ...cwdArgs, "--", "aven", "--workspace", workspace, "tui", epic.ref];
}

export function isLiveEpicTerminal(terminal, workspace, epicId) {
  return terminal?.state === "live" && String(terminal?.name ?? "").startsWith(terminalName(workspace, epicId));
}

export function normalizeFolder(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

// A dispatched worktree is either the attempt's own checkout or one of its
// phase worktrees. Only an exact one-to-one match is authoritative.
export function dispatchTargets(attempts = [], folder = "") {
  const target = normalizeFolder(folder);
  if (!target) return [];
  const targets = [];
  for (const attempt of attempts ?? []) {
    if (normalizeFolder(attempt?.worktree) === target) {
      targets.push({ attempt, taskRef: String(attempt?.task_ref ?? ""), phase: null });
      continue;
    }
    const phase = (attempt?.phases ?? []).find((entry) => normalizeFolder(entry?.worktree) === target);
    if (phase) targets.push({ attempt, taskRef: String(phase?.task_ref ?? ""), phase });
  }
  return targets;
}

const TERMINAL_STATUSES = new Set(["done", "canceled"]);
const REVIEW_EXECUTION_STATES = new Set(["needs-review", "completed"]);
const ACTIVE_EXECUTION_STATES = new Set([
  "running", "waiting", "starting", "queued", "failed", "interrupted",
  "workspace-pending", "session-pending", "terminal-pending", "prompt-pending",
  "babysitter-session-pending", "babysitter-prompt-pending",
]);
const STATUS_LABELS = {
  inbox: "Inbox",
  backlog: "Backlog",
  todo: "Todo",
  active: "Active",
  done: "Done",
  canceled: "Canceled",
};
const DISPATCH_LABELS = {
  running: "Running",
  waiting: "Waiting",
  starting: "Starting",
  queued: "Queued",
  "needs-review": "Needs review",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  "workspace-pending": "Preparing workspace",
  "session-pending": "Creating session",
  "terminal-pending": "Starting terminal",
  "prompt-pending": "Admitting prompt",
  "babysitter-session-pending": "Starting babysitter",
  "babysitter-prompt-pending": "Admitting babysitter prompt",
};

export function statusLabel(status) {
  const value = String(status ?? "");
  return STATUS_LABELS[value] ?? (value ? value[0].toUpperCase() + value.slice(1) : "Unknown");
}

export function dispatchLabel(state) {
  const value = String(state ?? "").trim();
  if (!value) return "Not dispatched";
  return DISPATCH_LABELS[value] ?? value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
}

// One lifecycle stage for the focused task. Aven status is acceptance; the
// persisted attempt is execution, and a review state stays visible even when
// the task already reads as done.
export function lifecycleStage({ status, attempt } = {}) {
  const state = String(attempt?.state ?? "");
  if (REVIEW_EXECUTION_STATES.has(state)) return "Review";
  if (ACTIVE_EXECUTION_STATES.has(state)) return "In progress";
  switch (String(status ?? "")) {
    case "done": return "Done";
    case "canceled": return "Canceled";
    case "active": return "In progress";
    case "todo": return "Planned";
    case "backlog": return "Backlog";
    case "inbox": return "Inbox";
    default: return "Unknown";
  }
}

export function phaseProgress(children = []) {
  const total = Array.isArray(children) ? children.length : 0;
  const complete = (children ?? []).filter((child) => child?.open === false || TERMINAL_STATUSES.has(child?.status)).length;
  return { complete, total };
}

// The phase the focused worktree represents, or the active/next phase when the
// worktree belongs to the root epic.
export function focusedPhase(root, task) {
  const children = Array.isArray(root?.epic_children) ? root.epic_children : [];
  const ref = String(task?.ref ?? "");
  const index = children.findIndex((child) => child?.ref === ref);
  if (index >= 0) return { phase: children[index], position: index + 1, total: children.length, current: true };
  if (ref && ref === String(root?.ref ?? "")) {
    const active = children.findIndex((child) => child?.status === "active");
    const next = active >= 0 ? active : children.findIndex((child) => ["todo", "inbox", "backlog"].includes(child?.status));
    return { phase: next >= 0 ? children[next] : null, position: next >= 0 ? next + 1 : 0, total: children.length, current: false };
  }
  return { phase: null, position: 0, total: children.length, current: false };
}

// The whole phase plan for the focused root epic. "active" follows Aven's
// acceptance state (the first active child); "worktree" follows the exact task
// ref of the selected checkout, so a root worktree never names a phase.
export function phaseOverview(root, task) {
  const children = Array.isArray(root?.epic_children) ? root.epic_children : [];
  const activeRef = children.find((child) => String(child?.status ?? "") === "active")?.ref ?? "";
  const worktreeRef = children.find((child) => child?.ref === task?.ref)?.ref ?? "";
  return {
    activeRef,
    worktreeRef,
    phases: children.map((phase, index) => ({
      ...phase,
      position: index + 1,
      active: Boolean(activeRef) && phase.ref === activeRef,
      worktree: Boolean(worktreeRef) && phase.ref === worktreeRef,
    })),
  };
}

// Dispatcher data is only authoritative when it names this exact worktree.
export function resolveSpaceContext({ space, attempts = [], task, root, rows = [], target }) {
  const folder = normalizeFolder(space?.folder);
  const name = String(space?.name ?? "");
  if (!folder) return { kind: "missing", name, folder, message: "This space has no worktree folder." };
  const matches = target ? [target] : dispatchTargets(attempts, folder);
  if (matches.length !== 1) return { kind: matches.length ? "ambiguous" : "unavailable", name, folder, message: matches.length ? "Multiple dispatches found; showing project epics." : "Project space; showing project epics." };
  if (!task?.ref || !root?.is_epic || !root?.id) return { kind: "stale", name, folder, message: "Dispatcher context no longer resolves to an Aven root epic." };
  const pinned = rows.find((row) => canonicalId(row) === canonicalId(root)) ?? null;
  const match = matches[0];
  return {
    kind: "dispatch", name, folder, task, root, pinned,
    attempt: match.attempt, phase: match.phase, taskRef: match.taskRef,
    message: pinned ? "Dispatcher root epic is listed below." : "Dispatcher root epic is not in the current safe result set.",
  };
}
