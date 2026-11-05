// Pure Kanban read-model and command contracts. This file deliberately has no
// GPUI or process dependencies so lifecycle and ownership policy can be tested
// with ordinary Node fixtures.
export const LIMIT = 500;
export const ATTEMPT_LIMIT = 500;
export const MERGE_PROMPT = "/ha-merge merge into local main";
export const BOARD_COLUMNS = [
  { id: "backlog", title: "Backlog" },
  { id: "planned", title: "Planned" },
  { id: "progress", title: "In progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];
export const DISPATCH_ACTIONS = [
  { id: "dispatch", detailKey: "d", terminalKey: "d", label: "z d", description: "Dispatch task" },
  { id: "plan-implement", detailKey: "s", terminalKey: "s", label: "z s", description: "Plan then implement" },
  { id: "plan", detailKey: "p", terminalKey: "p", label: "z p", description: "Create implementation plan" },
  { id: "implement", detailKey: "i", terminalKey: "i", label: "z i", description: "Implement existing plan" },
  { id: "reset", detailKey: "r", terminalKey: "r", label: "z r", description: "Reset dispatcher execution" },
  { id: "plan-implement-babysitter", detailKey: "x", terminalKey: "x", label: "z x", description: "Plan then implement with babysitter" },
  { id: "implement-babysitter", detailKey: "b", terminalKey: "b", label: "z b", description: "Implement with babysitter" },
];

const TERMINAL_STATUSES = new Set(["done", "canceled"]);
const ACTIVE_EXECUTION_STATES = new Set([
  "running", "waiting", "starting", "queued", "failed", "interrupted",
  "workspace-pending", "session-pending", "terminal-pending", "prompt-pending",
  "babysitter-session-pending", "babysitter-prompt-pending",
]);
const REVIEW_EXECUTION_STATES = new Set(["needs-review", "completed"]);
const PENDING_DELIVERY_STATES = new Set(["pending", "committed"]);
const RECORDED_DELIVERY_STATES = new Set(["merged", "not-applicable", "superseded", "waived"]);

export function assertBoardCoverage({ available = 0, upcoming = 0, attempts = 0, epics = 0 }) {
  if (available >= LIMIT || upcoming >= LIMIT || epics >= LIMIT) throw new Error(`epic read reached the ${LIMIT}-item safety limit`);
  if (attempts >= ATTEMPT_LIMIT) throw new Error(`dispatcher read reached the ${ATTEMPT_LIMIT}-attempt safety limit`);
}

export function epicArgs(workspace) {
  return ["list", "--workspace", workspace, "--epics", "--limit", String(LIMIT), "--json"];
}

export function upcomingArgs(workspace) {
  return ["list", "--workspace", workspace, "--upcoming", "--limit", String(LIMIT), "--json"];
}

export function detailArgs(workspace, ref) {
  return ["show", ref, "--workspace", workspace, "--full", "--json"];
}

function canonicalId(row) {
  return String(row?.id ?? row?.canonical_id ?? "").trim();
}

function qualifiedRef(row) {
  return String(row?.ref ?? row?.display_ref ?? "").trim();
}

function timeValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function phaseProgress(children) {
  const total = Array.isArray(children) ? children.length : 0;
  const complete = (children ?? []).filter((child) => child?.open === false || TERMINAL_STATUSES.has(child?.status)).length;
  return { complete, total };
}

// Normalize only the fields the board renders. In particular, dispatcher
// pending_prompt and Aven descriptions/notes never enter the view model.
export function normalizeEpic(row, detail) {
  const id = canonicalId(row);
  const ref = qualifiedRef(row);
  if (!id || !ref || row?.deleted || row?.is_epic !== true) return null;
  const detailTask = detail?.task;
  const hydrated = detailTask?.id === id && detailTask?.is_epic === true;
  const metadata = hydrated && detail?.metadata && typeof detail.metadata === "object" ? detail.metadata : {};
  const children = hydrated && Array.isArray(detailTask.epic_children) ? detailTask.epic_children : (row.epic_children ?? []);
  return {
    id,
    ref,
    title: String(hydrated && detailTask.title ? detailTask.title : (row.title ?? "Untitled epic")),
    project: String(row.project?.key ?? row.project ?? ""),
    status: String(hydrated && detailTask.status ? detailTask.status : (row.status ?? "unknown")),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    available_at: String(row.available_at ?? ""),
    hydrated,
    mergedOnMain: row.mergedOnMain === true,
    planWorkedOut: hydrated && metadata["sdd.plan-worked-out"] === "true",
    deliveryState: hydrated ? String(metadata["delivery.state"] ?? "") : "",
    deliveryTarget: hydrated ? String(metadata["delivery.target"] ?? "") : "",
    deliveryObligation: hydrated ? String(metadata["delivery.obligation"] ?? "") : "",
    phases: phaseProgress(children),
  };
}

export function mergeEpicRows({ available = [], upcoming = [], details = {} }) {
  const rows = new Map();
  for (const raw of [...available, ...upcoming]) {
    const id = canonicalId(raw);
    if (!id || rows.has(id)) continue;
    const row = normalizeEpic(raw, details[id]);
    if (row) rows.set(id, row);
  }
  return [...rows.values()].sort((left, right) => {
    const updated = timeValue(right.updated_at) - timeValue(left.updated_at);
    if (updated) return updated;
    const created = timeValue(right.created_at) - timeValue(left.created_at);
    return created || left.id.localeCompare(right.id);
  });
}

export function markMergedOnMain(rows, mergedTaskIds) {
  return (rows ?? []).map((row) => ({ ...row, mergedOnMain: mergedTaskIds.has(row.id) }));
}

function terminal(value) {
  return {
    address: String(value?.address ?? ""),
    coreId: String(value?.core_id ?? value?.coreId ?? ""),
    name: String(value?.name ?? ""),
  };
}

export function normalizeAttempt(attempt) {
  return {
    taskId: String(attempt?.task_id ?? attempt?.taskId ?? ""),
    taskRef: String(attempt?.task_ref ?? attempt?.taskRef ?? ""),
    workflow: String(attempt?.workflow ?? ""),
    attemptId: String(attempt?.attempt_id ?? attempt?.attemptId ?? ""),
    generation: Number.isFinite(Number(attempt?.generation)) ? Number(attempt.generation) : 0,
    createdAt: Number.isFinite(Number(attempt?.created_at ?? attempt?.createdAt)) ? Number(attempt?.created_at ?? attempt?.createdAt) : 0,
    state: String(attempt?.state ?? "unknown"),
    executionMode: String(attempt?.execution_mode ?? attempt?.executionMode ?? "single-session"),
    worktree: String(attempt?.worktree ?? ""),
    branch: String(attempt?.branch ?? ""),
    contradiction: String(attempt?.lifecycle?.contradiction ?? attempt?.contradiction ?? ""),
    terminal: terminal(attempt?.terminal),
    coordinatorTerminal: terminal(attempt?.coordinator_terminal ?? attempt?.coordinatorTerminal),
  };
}

export function indexAttempts(attempts) {
  const index = new Map();
  for (const raw of attempts ?? []) {
    const attempt = normalizeAttempt(raw);
    if (!attempt.taskId) continue;
    if (!index.has(attempt.taskId)) index.set(attempt.taskId, []);
    index.get(attempt.taskId).push(attempt);
  }
  return index;
}

// Multiple workflows/generations may exist for one root. Only a tie at the
// selected ordering boundary is ambiguous; older attempts never block review.
export function selectAttempt(attempts, taskId) {
  const byIdentity = new Map();
  for (const raw of attempts ?? []) {
    const attempt = normalizeAttempt(raw);
    if (attempt.taskId !== taskId || !attempt.attemptId) continue;
    const key = `${attempt.attemptId}\u0000${attempt.workflow}`;
    if (!byIdentity.has(key)) byIdentity.set(key, attempt);
  }
  const candidates = [...byIdentity.values()].sort((left, right) =>
    right.generation - left.generation || right.createdAt - left.createdAt ||
    right.attemptId.localeCompare(left.attemptId) || right.workflow.localeCompare(left.workflow));
  if (!candidates.length) return { attempt: null, ambiguous: false, candidates: [] };
  const [first, second] = candidates;
  const ambiguous = Boolean(second && first.generation === second.generation && first.createdAt === second.createdAt);
  return { attempt: ambiguous ? null : first, ambiguous, candidates };
}

export function mergeRole(attempt) {
  return attempt?.executionMode === "worktrees" ? "coordinator" : "builder";
}

export function mergeTerminal(attempt) {
  return mergeRole(attempt) === "coordinator" ? attempt?.coordinatorTerminal : attempt?.terminal;
}

export function mergeArgs(epic, attempt) {
  const target = mergeTerminal(attempt);
  if (!epic?.id || !attempt?.workflow || !attempt?.attemptId || !target?.address) throw new Error("No unambiguous review terminal is available.");
  return [
    "message", epic.id,
    "--workflow", attempt.workflow,
    "--attempt-id", attempt.attemptId,
    "--generation", String(attempt.generation),
    "--role", mergeRole(attempt),
    "--terminal", target.address,
    "--text", MERGE_PROMPT,
  ];
}

function executionState(attempt) {
  if (!attempt) return "";
  if (REVIEW_EXECUTION_STATES.has(attempt.state)) return "review";
  if (ACTIVE_EXECUTION_STATES.has(attempt.state)) return "active";
  return "unknown";
}

export function cardForEpic(epic, attemptSelection) {
  const attempt = attemptSelection?.attempt ?? null;
  const execution = executionState(attempt);
  const warnings = [];
  if (attemptSelection?.ambiguous) warnings.push("Multiple current dispatcher attempts; actions paused.");
  if (attempt?.contradiction) warnings.push(attempt.contradiction.replaceAll("_", " "));
  if (!epic.hydrated && epic.status === "todo") warnings.push("Plan metadata is not loaded yet.");
  if (TERMINAL_STATUSES.has(epic.status) && execution === "active") warnings.push("Terminal Aven status conflicts with active execution.");

  const terminalStatus = TERMINAL_STATUSES.has(epic.status);
  const deliveredByMain = terminalStatus && epic.mergedOnMain === true;
  if (deliveredByMain && !RECORDED_DELIVERY_STATES.has(epic.deliveryState)) {
    warnings.push("On main; closeout not recorded.");
  }

  let column;
  if (deliveredByMain) column = "done";
  else if (PENDING_DELIVERY_STATES.has(epic.deliveryState)) column = "review";
  else if (terminalStatus && execution === "active") column = "review";
  else if (epic.status === "canceled") column = "done";
  else if (epic.status === "done") column = execution === "review" && attempt?.state === "needs-review" ? "review" : "done";
  else if (execution === "review") column = "review";
  else if (epic.status === "active" || execution === "active") column = "progress";
  else if (epic.status === "todo" && epic.planWorkedOut) column = "planned";
  else column = "backlog";

  const terminal = mergeTerminal(attempt);
  const mergeable = column === "review" && execution === "review" && !attempt?.contradiction && Boolean(attempt?.workflow && terminal?.address) && !attemptSelection?.ambiguous;
  return {
    ...epic,
    column,
    attempt,
    attemptAmbiguous: Boolean(attemptSelection?.ambiguous),
    executionState: attempt?.state ?? "",
    mergeRole: mergeable ? mergeRole(attempt) : "",
    mergeTerminal: mergeable ? terminal : null,
    mergeable,
    warnings,
  };
}

export function buildBoard({ rows = [], attempts = [], attemptIndex }) {
  const columns = BOARD_COLUMNS.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  const attemptsByTask = attemptIndex ?? indexAttempts(attempts);
  for (const epic of rows) {
    const card = cardForEpic(epic, selectAttempt(attemptsByTask.get(epic.id) ?? [], epic.id));
    byId.get(card.column)?.cards.push(card);
  }
  return columns;
}

export function flattenBoard(columns) {
  return (columns ?? []).flatMap((column) => column.cards ?? []);
}

export function moveSelection(columns, selectedId, delta) {
  const cards = flattenBoard(columns);
  if (!cards.length) return "";
  const index = cards.findIndex((card) => card.id === selectedId);
  if (index < 0) return cards[0].id;
  return cards[(index + delta + cards.length) % cards.length].id;
}

export function selectedCard(columns, selectedId) {
  return flattenBoard(columns).find((card) => card.id === selectedId) ?? null;
}

function terminalHash(value) {
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0").slice(0, 4)}`;
}

export function terminalName(workspace, epicId) {
  return `aven-k-${terminalHash(`${workspace}\u0000${epicId}`)}-`;
}

export function isLiveEpicTerminal(terminalValue, workspace, epicId) {
  return terminalValue?.state === "live" && String(terminalValue?.name ?? "").startsWith(terminalName(workspace, epicId));
}

export function openArgs({ workspace, epic, cwd, name }) {
  return ["run", "--bg", "--json", "--no-parent", "--outlive-parent", "--name", name,
    ...(cwd ? ["--cwd", cwd] : []), "--", "aven", "--workspace", workspace, "tui", epic.ref];
}

export function dispatchTerminalName(workspace, epicId, action) {
  return `${terminalName(workspace, epicId)}${action.terminalKey}-`;
}
