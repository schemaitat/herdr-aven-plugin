// Pure Kanban read-model and command contracts. This file deliberately has no
// GPUI or process dependencies so lifecycle and ownership policy can be tested
// with ordinary Node fixtures.
export const LIMIT = 500;
export const ATTEMPT_LIMIT = 500;
export const MERGE_PROMPT = "/ha-merge";
export const CREATED_FILTERS = [
  { id: "all", label: "All", days: null },
  { id: "1w", label: "1w", days: 7 },
  { id: "2w", label: "2w", days: 14 },
  { id: "1mo", label: "1mo", days: 30 },
  { id: "1y", label: "1y", days: 365 },
];
export const BOARD_COLUMNS = [
  { id: "backlog", title: "Backlog" },
  { id: "planned", title: "Planned out" },
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
const WORKING_EXECUTION_STATES = new Set([
  "running", "waiting", "starting", "queued",
  "workspace-pending", "session-pending", "terminal-pending", "prompt-pending",
  "babysitter-session-pending", "babysitter-prompt-pending",
]);
const REVIEW_EXECUTION_STATES = new Set(["needs-review", "completed"]);
const STOPPED_OBSERVATIONS = new Set(["stopped-success", "stopped-failure", "stopped-interrupted"]);
const STOPPED_TERMINAL_STATES = new Set(["finished", "removed"]);
const PENDING_DELIVERY_STATES = new Set(["pending", "committed"]);
const RECORDED_DELIVERY_STATES = new Set(["merged", "not-applicable", "superseded", "waived"]);

export function assertBoardCoverage({ available = 0, upcoming = 0, attempts = 0, epics = 0 }) {
  if (available >= LIMIT || upcoming >= LIMIT || epics >= LIMIT) throw new Error(`epic read reached the ${LIMIT}-item safety limit`);
  if (attempts >= ATTEMPT_LIMIT) throw new Error(`dispatcher read reached the ${ATTEMPT_LIMIT}-attempt safety limit`);
}

export function createdCutoff(filterId, now = Date.now()) {
  const filter = CREATED_FILTERS.find((candidate) => candidate.id === filterId);
  if (!filter || filter.days == null) return 0;
  return now - filter.days * 86_400_000;
}

// A finite creation window hides unknown timestamps rather than claiming they
// are recent. "all" keeps every row, including rows with an unusable date.
export function filterRowsByCreated(rows, filterId, now = Date.now()) {
  const list = rows ?? [];
  const cutoff = createdCutoff(filterId, now);
  if (!cutoff) return list;
  return list.filter((row) => {
    const created = timeValue(row?.created_at);
    return created > 0 && created >= cutoff;
  });
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
  const childIds = (Array.isArray(children) ? children : [])
    .map((child) => String(child?.id ?? "").trim())
    .filter(Boolean);
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
    approvalState: hydrated ? String(metadata["approval.state"] ?? "") : "",
    approved: hydrated && metadata["approval.state"] === "approved",
    deliveryState: hydrated ? String(metadata["delivery.state"] ?? "") : "",
    deliveryTarget: hydrated ? String(metadata["delivery.target"] ?? "") : "",
    deliveryObligation: hydrated ? String(metadata["delivery.obligation"] ?? "") : "",
    taskIds: [id, ...childIds],
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

function terminalObservation(role, value) {
  return {
    role: String(role ?? ""),
    address: String(value?.address ?? ""),
    state: String(value?.state ?? ""),
    status: String(value?.status ?? ""),
  };
}

// Attempt payloads record role terminals as an object keyed by role; tolerate an
// already-normalized list so the read model stays idempotent.
function terminalObservations(value) {
  if (Array.isArray(value)) return value.map((observation, index) => terminalObservation(observation?.role ?? index, observation));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([role, observation]) => terminalObservation(role, observation));
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
    observation: String(attempt?.lifecycle?.observation ?? attempt?.observation ?? ""),
    contradiction: String(attempt?.lifecycle?.contradiction ?? attempt?.contradiction ?? ""),
    terminals: terminalObservations(attempt?.terminals ?? attempt?.terminal_observations),
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

export function mergePrompt(epic) {
  if (!epic?.id) throw new Error("No approved task identity is available.");
  return `${MERGE_PROMPT} ${epic.id}`;
}

export function mergeTabName(epic) {
  if (!epic?.ref) throw new Error("No approved task reference is available.");
  return `merge ${epic.ref}`;
}

// Herdr appends a tab's first message to the agent argv as its last token.
// OpenCode treats a bare positional argument as a project directory, so give
// it the supported --prompt flag for that trailing message instead.
export function mergeAgentRun(argv) {
  const run = Array.isArray(argv) ? argv : [];
  const program = String(run[0] ?? "").split(/[\\/]/).pop();
  if (program !== "opencode" || run.includes("--prompt")) return run;
  return [...run, "--prompt"];
}

export function mergeTabArgs({ name, space, folder, argv, task }) {
  if (!name || !space || !folder || !Array.isArray(argv) || argv.length === 0 || !task) {
    throw new Error("A main-space merge tab needs a name, space, folder, agent, and prompt.");
  }
  return ["do", "tab.new", "--name", name, "--space", space, "--folder", folder,
    "--argv", JSON.stringify(mergeAgentRun(argv)), "--task", task];
}

function normalizedPath(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

// Integration belongs in the primary checkout, not in whichever worktree space
// the board was opened from. Prefer an already-visible space for that folder;
// if none exists, fall back to the active space and run the tab there.
export function selectMainSpace(spaces, root, activeSpaceId = "") {
  const list = spaces ?? [];
  const folder = normalizedPath(root);
  const candidates = folder
    ? list.filter((space) => normalizedPath(space?.folder) === folder)
    : [];
  const active = candidates.find((space) => space?.id === activeSpaceId);
  if (active) return active;
  const repository = folder.split("/").filter(Boolean).pop() ?? "";
  const named = candidates.find((space) => String(space?.name ?? "") === repository);
  if (named) return named;
  if (candidates.length) return candidates[0];
  return list.find((space) => space?.id === activeSpaceId) ?? null;
}

function executionState(attempt) {
  if (!attempt) return "";
  if (REVIEW_EXECUTION_STATES.has(attempt.state)) return "review";
  if (ACTIVE_EXECUTION_STATES.has(attempt.state)) return "active";
  return "unknown";
}

function terminalAddresses(attempt) {
  return new Set([
    attempt.terminal?.address,
    attempt.coordinatorTerminal?.address,
    ...(attempt.terminals ?? []).map((observation) => observation.address),
  ].map((address) => String(address ?? "")).filter(Boolean));
}

// A read-only summary can expose a checkpoint that was never reduced after its
// terminals stopped. A stopped lifecycle observation or a fully stopped set of
// recorded role terminals is durable evidence that nothing is working; an
// attempt without terminal observations keeps the previous state-based signal.
function attemptStopped(attempt) {
  if (STOPPED_OBSERVATIONS.has(attempt.observation)) return true;
  const observed = (attempt.terminals ?? []).filter((observation) => observation.address);
  return observed.length > 0 && observed.every((observation) => STOPPED_TERMINAL_STATES.has(observation.state));
}

export function attemptWorking(attempt, liveAgents = []) {
  if (!attempt) return false;
  const addresses = terminalAddresses(attempt);
  if (addresses.size && liveAgents.some((live) => live.status === "working" && addresses.has(String(live.address ?? "")))) return true;
  return WORKING_EXECUTION_STATES.has(attempt.state) && !attemptStopped(attempt);
}

export function cardForEpic(epic, attemptSelection, relatedAttempts = [], liveAgents = []) {
  const attempt = attemptSelection?.attempt ?? null;
  const execution = executionState(attempt);
  const attempts = (relatedAttempts.length ? relatedAttempts : (attempt ? [attempt] : [])).map(normalizeAttempt);
  const terminalStatus = TERMINAL_STATUSES.has(epic.status);
  const working = attempts.some((candidate) => attemptWorking(candidate, liveAgents));
  const warnings = [];
  if (attemptSelection?.ambiguous) warnings.push("Multiple current dispatcher attempts; dispatch actions paused.");
  if (attempt?.contradiction) warnings.push(attempt.contradiction.replaceAll("_", " "));
  if (!epic.hydrated && epic.status === "todo") warnings.push("Plan metadata is not loaded yet.");
  if (terminalStatus && execution === "active" && working) warnings.push("Terminal Aven status conflicts with active execution.");

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

  // Aven acceptance is authoritative: terminal work is inert for dispatch, so a
  // done/canceled card never claims activity. Genuine activity stays visible as
  // the contradiction warning above instead.
  const agentActive = !terminalStatus && working;
  const approved = epic.approved === true;
  const readyToMerge = column === "review" && approved && epic.status !== "canceled";
  return {
    ...epic,
    column,
    attempt,
    relatedAttempts: attempts,
    attemptAmbiguous: Boolean(attemptSelection?.ambiguous),
    executionState: attempt?.state ?? "",
    approved,
    readyToMerge,
    mergeable: readyToMerge,
    agentActive,
    warnings,
  };
}

export function buildBoard({ rows = [], attempts = [], attemptIndex, liveAgents = [] }) {
  const columns = BOARD_COLUMNS.map((column) => ({ ...column, cards: [] }));
  const byId = new Map(columns.map((column) => [column.id, column]));
  const attemptsByTask = attemptIndex ?? indexAttempts(attempts);
  for (const epic of rows) {
    const taskIds = Array.isArray(epic.taskIds) && epic.taskIds.length ? epic.taskIds : [epic.id];
    const relatedAttempts = taskIds.flatMap((taskId) => attemptsByTask.get(taskId) ?? []);
    const card = cardForEpic(
      epic,
      selectAttempt(attemptsByTask.get(epic.id) ?? [], epic.id),
      relatedAttempts,
      liveAgents,
    );
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
