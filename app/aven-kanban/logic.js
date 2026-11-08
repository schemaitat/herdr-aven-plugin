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
// Board order mirrors the reference layout: Aven keeps one intake column where
// the layout has none, then the three action columns and the archive column.
export const BOARD_COLUMNS = [
  { id: "backlog", title: "BACKLOG", tone: "dim" },
  { id: "needs_you", title: "NEEDS YOU", tone: "attention" },
  { id: "working", title: "WORKING", tone: "working" },
  { id: "ready", title: "READY TO LAND", tone: "land" },
  { id: "done", title: "DONE", tone: "done" },
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

// Metadata that gates approval, delivery, or plan badges. Everything else in an
// `aven show --full` payload stays outside the board model.
export const DETAIL_METADATA = [
  "sdd.plan-worked-out", "approval.state", "approval.id", "approval.commit", "approval.workflow",
  "delivery.state", "delivery.target", "delivery.obligation",
];

// A malformed or unexpected detail payload must never become board evidence.
export function safeDetail(payload) {
  const task = payload?.task ?? {};
  const metadata = {};
  for (const key of DETAIL_METADATA) {
    if (typeof payload?.metadata?.[key] === "string") metadata[key] = payload.metadata[key];
  }
  return {
    task: {
      id: String(task.id ?? ""), ref: String(task.ref ?? ""), title: String(task.title ?? ""),
      status: String(task.status ?? ""), is_epic: task.is_epic === true,
      epic_children: Array.isArray(task.epic_children) ? task.epic_children.map((child) => ({
        id: String(child?.id ?? ""), ref: String(child?.ref ?? ""), title: String(child?.title ?? ""),
        status: String(child?.status ?? ""), open: child?.open !== false,
      })) : [],
    },
    metadata,
  };
}

// Run async work over a list with a small fixed pool. Results keep input order
// and the pool never exceeds `limit`, so process-spawning reads cannot storm.
export async function mapLimit(items, limit, worker) {
  const list = items ?? [];
  const results = new Array(list.length);
  if (!list.length) return results;
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length));
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await worker(list[index], index);
    }
  }));
  return results;
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

// Dispatcher merge requires a durable marker, not just approval.state. Keep the
// board's necessary-condition check pure and identical for hydrate and preflight.
export function approvalMarker(metadata) {
  const state = String(metadata?.["approval.state"] ?? "").trim();
  const id = String(metadata?.["approval.id"] ?? "").trim();
  const commit = String(metadata?.["approval.commit"] ?? "").trim();
  const workflow = String(metadata?.["approval.workflow"] ?? "").trim();
  const approved = state === "approved" && Boolean(id) && Boolean(commit) && Boolean(workflow);
  return { state, id, commit, workflow, approved, incomplete: state === "approved" && !approved };
}

// Aven tasks are workspace-scoped. Hydrated details must never be reused across
// workspaces, and a changed or failed read must invalidate the cached snapshot.
export function detailCacheKey(workspace, id) {
  return `${String(workspace ?? "")}\u0000${String(id ?? "")}`;
}

export function detailIsCurrent(cached, workspace, row) {
  return cached?.workspace === String(workspace ?? "") && cached?.updatedAt === row?.updated_at;
}

// Aven `updated_at` has second granularity, so a metadata-only edit inside the
// same second can leave the row timestamp unchanged. Re-read anything that can
// affect the merge gate on every refresh instead of trusting the timestamp.
export function detailNeedsRefresh(cached, workspace, row) {
  if (!detailIsCurrent(cached, workspace, row)) return true;
  return cached.detail?.task?.status === "done"
    || Boolean(cached.detail?.metadata?.["approval.state"]);
}

// Hydrate the details that are stale or absent, publishing each outcome as soon
// as it lands so the board can enrich incrementally. `publish(row, snapshot)`
// receives a cache-ready snapshot, or null when the read must invalidate any
// older approval evidence. Failures are returned, never swallowed silently.
export async function hydrateDetails({
  rows = [], workspace = "", cached = () => undefined, read, publish = () => {}, limit = 4,
}) {
  const needed = rows.filter((row) => detailNeedsRefresh(cached(row), workspace, row));
  const failures = [];
  await mapLimit(needed, limit, async (row) => {
    const key = qualifiedRef(row);
    try {
      const detail = safeDetail(await read(row));
      if (detail.task.id !== canonicalId(row) || !detail.task.is_epic) throw new Error("identity mismatch");
      publish(row, { workspace: String(workspace), updatedAt: row?.updated_at, detail });
    } catch (error) {
      publish(row, null);
      failures.push(`${key}: ${String(error?.message ?? error)}`);
    }
  });
  return { needed: needed.length, failures };
}

// Merge, ship, and archive depend on a completely classified board. Until the
// background stages finish, those actions stay closed rather than acting on a
// provisional column.
export function enrichmentPending(state) {
  return state?.enriching === true || state?.evidencePending === true;
}

export function cardArchiveable(card, state) {
  return card?.column === "done" && card?.hydrated === true && !enrichmentPending(state);
}

// Fresh-read gate for the merge handoff. Returns a human-readable list of the
// missing pieces, or an empty string when the exact task may open /ha-merge.
export function mergeApprovalIssue(task, metadata) {
  const approval = approvalMarker(metadata);
  const missing = [];
  if (approval.state !== "approved") missing.push(`state=${approval.state || "missing"}`);
  if (!approval.id) missing.push("approval.id");
  if (!approval.commit) missing.push("approval.commit");
  if (!approval.workflow) missing.push("approval.workflow");
  if (task?.status !== "done") missing.push(`status=${task?.status || "unknown"}`);
  return missing.join(", ");
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
  const status = String(hydrated && detailTask.status ? detailTask.status : (row.status ?? "unknown"));
  const approval = approvalMarker(hydrated ? metadata : {});
  return {
    id,
    ref,
    title: String(hydrated && detailTask.title ? detailTask.title : (row.title ?? "Untitled epic")),
    project: String(row.project?.key ?? row.project ?? ""),
    status,
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
    available_at: String(row.available_at ?? ""),
    hydrated,
    mergedOnMain: row.mergedOnMain === true,
    planWorkedOut: hydrated && metadata["sdd.plan-worked-out"] === "true",
    approvalState: approval.state,
    approvalId: approval.id,
    approvalCommit: approval.commit,
    approvalWorkflow: approval.workflow,
    approved: hydrated && status === "done" && approval.approved,
    approvalIncomplete: hydrated && approval.incomplete,
    approvalInvalid: hydrated && (approval.incomplete || (approval.approved && status !== "done")),
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

// Ship PR is a separate agent handoff, like Merge: the board never pushes or
// opens a pull request itself.
export function shipPrompt(epic) {
  if (!epic?.id) throw new Error("No approved task identity is available.");
  return `Ship the approved result for Aven task ${epic.id} as a pull request. Work from the primary checkout. Push only the approved task branch, open a pull request following the repository conventions, and do not merge, force-push, rewrite history, or change Aven acceptance. Report the pull request URL.`;
}

export function shipTabName(epic) {
  if (!epic?.ref) throw new Error("No approved task reference is available.");
  return `ship ${epic.ref}`;
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

function insideFolder(value, folder) {
  const path = normalizedPath(value);
  return Boolean(path) && Boolean(folder) && (path === folder || path.startsWith(`${folder}/`));
}

// A space's `folder` is only where new terminals start, so it can point at
// `$HOME` (or a stale checkout) while the space still shows the repository.
// Herdr takes a space's repository from the terminal its first tab shows; read
// that live pane folder instead of trusting `folder`.
export function firstPaneFolder(space, panes) {
  const tabs = Array.isArray(space?.tabs) ? [...space.tabs] : [];
  tabs.sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0));
  for (const tab of tabs) {
    const pane = (panes ?? []).find((candidate) =>
      candidate?.tab === tab?.id && typeof candidate?.cwd === "string" && candidate.cwd);
    if (pane) return String(pane.cwd);
  }
  return "";
}

// Integration belongs in the primary checkout, not in whichever worktree space
// the board was opened from. Prefer the visible space whose first tab actually
// lives there; `space.folder` is only a fallback when no live pane data exists.
// If no space matches, fall back to the active space and run the tab there.
export function selectMainSpace(spaces, root, activeSpaceId = "", panes = []) {
  const list = spaces ?? [];
  const folder = normalizedPath(root);
  const live = folder
    ? list.filter((space) => insideFolder(firstPaneFolder(space, panes), folder))
    : [];
  const candidates = live.length
    ? live
    : folder
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

// A stored terminal observation is a checkpoint from an earlier read. Only a
// live herdr agent at a recorded role terminal is current evidence that an
// accepted task's execution is still active.
export function attemptLiveWorking(attempt, liveAgents = []) {
  if (!attempt) return false;
  const addresses = terminalAddresses(attempt);
  if (!addresses.size) return false;
  return (liveAgents ?? []).some((live) =>
    live.status === "working" && addresses.has(String(live.address ?? "")));
}

export function attemptWorking(attempt, liveAgents = []) {
  if (!attempt) return false;
  if (attemptLiveWorking(attempt, liveAgents)) return true;
  return WORKING_EXECUTION_STATES.has(attempt.state) && !attemptStopped(attempt);
}

// NEEDS YOU is a presentation fact: a live agent (or a live terminal
// observation) reports that it is blocked. It never changes Aven.
export function liveAgentFor(attempt, liveAgents = []) {
  const addresses = terminalAddresses(attempt);
  if (!addresses.size) return null;
  return (liveAgents ?? []).find((live) => addresses.has(String(live.address ?? ""))) ?? null;
}

export function attemptNeedsYou(attempt, liveAgents = []) {
  if (!attempt) return false;
  return Boolean(blockedAddress([attempt], liveAgents));
}

export function blockedAddress(attempts, liveAgents = []) {
  for (const attempt of attempts ?? []) {
    const addresses = terminalAddresses(attempt);
    const live = (liveAgents ?? []).find((agent) => addresses.has(String(agent.address ?? "")) && agent.status === "blocked");
    if (live) return String(live.address);
    const observation = (attempt.terminals ?? []).find((item) => item.address && item.state === "live" && item.status === "blocked");
    if (observation) return observation.address;
  }
  return "";
}

export function cardForEpic(epic, attemptSelection, relatedAttempts = [], liveAgents = []) {
  const attempt = attemptSelection?.attempt ?? null;
  const execution = executionState(attempt);
  const attempts = (relatedAttempts.length ? relatedAttempts : (attempt ? [attempt] : [])).map(normalizeAttempt);
  const terminalStatus = TERMINAL_STATUSES.has(epic.status);
  const working = attempts.some((candidate) => attemptWorking(candidate, liveAgents));
  // The read-only dispatcher summary never reconciles its stored checkpoints.
  // For accepted work, only current live presence or the dispatcher's durable
  // contradiction may claim active execution.
  const terminalExecution = terminalStatus && (
    attempts.some((candidate) => Boolean(candidate.contradiction))
    || attempts.some((candidate) => attemptLiveWorking(candidate, liveAgents))
  );
  const needsYou = !terminalStatus && !attemptSelection?.ambiguous
    && attempts.some((candidate) => attemptNeedsYou(candidate, liveAgents));
  const warnings = [];
  if (attemptSelection?.ambiguous) warnings.push("Multiple current dispatcher attempts; dispatch actions paused.");
  if (attempt?.contradiction) warnings.push(attempt.contradiction.replaceAll("_", " "));
  if (!epic.hydrated && epic.status === "todo") warnings.push("Plan metadata is not loaded yet.");
  if (epic.approvalInvalid) warnings.push("Approval marker is incomplete or belongs to a non-done task; rerun /approve.");
  if (terminalExecution) warnings.push("Terminal Aven status conflicts with active execution.");

  const deliveredByMain = terminalStatus && epic.mergedOnMain === true;
  if (deliveredByMain && !RECORDED_DELIVERY_STATES.has(epic.deliveryState)) {
    warnings.push("On main; closeout not recorded.");
  }

  let column;
  if (deliveredByMain) column = "done";
  else if (PENDING_DELIVERY_STATES.has(epic.deliveryState)) column = "ready";
  // Until local-main ancestry is known, terminal work without an approval
  // cannot claim Ready to land. It stays Done provisionally and may move to
  // Ready once the evidence says its result is not on main.
  else if (epic.ancestryPending === true && terminalStatus && epic.approved !== true) column = "done";
  else if (terminalExecution) column = "ready";
  else if (epic.status === "canceled") column = "done";
  else if (epic.status === "done") column = execution === "review" && attempt?.state === "needs-review" ? "ready" : "done";
  else if (execution === "review") column = "ready";
  else if (epic.status === "active" || execution === "active") column = needsYou ? "needs_you" : "working";
  else column = "backlog";

  // Aven acceptance is authoritative: terminal work is inert for dispatch, so a
  // done/canceled card never claims activity. Genuine activity stays visible as
  // the contradiction warning above instead.
  const agentActive = !terminalStatus && working;
  const approved = epic.approved === true;
  const readyToMerge = column === "ready" && approved && epic.status === "done";
  return {
    ...epic,
    column,
    needsYou,
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

// Strip counts are derived from the board that was actually drawn, so a filter
// never shows totals for cards the person cannot see.
export function boardStats(columns) {
  const count = (id) => (columns ?? []).find((column) => column?.id === id)?.cards.length ?? 0;
  const cards = flattenBoard(columns);
  const counts = {
    total: cards.length,
    backlog: count("backlog"),
    needsYou: count("needs_you"),
    working: count("working"),
    ready: count("ready"),
    done: count("done"),
  };
  counts.open = counts.total - counts.done;
  return counts;
}

// The oldest needs-you card owns the NEXT MOVE banner.
export function nextMove(columns) {
  const needs = (columns ?? []).find((column) => column?.id === "needs_you")?.cards ?? [];
  return needs.slice().sort((left, right) => {
    const time = timeValue(left.updated_at || left.created_at) - timeValue(right.updated_at || right.created_at);
    return time || String(left.id).localeCompare(String(right.id));
  })[0] ?? null;
}

// "Landed" is presentation only: known local-main ancestry or recorded merged
// delivery. The result is oldest-first with today at index 6.
export function landedWeek(rows, now = Date.now()) {
  const counts = Array(7).fill(0);
  const today = Math.floor(now / 86_400_000);
  for (const row of rows ?? []) {
    if (row?.mergedOnMain !== true && row?.deliveryState !== "merged") continue;
    const at = timeValue(row?.updated_at || row?.created_at);
    if (!at) continue;
    const ago = today - Math.floor(at / 86_400_000);
    if (ago >= 0 && ago < 7) counts[6 - ago] += 1;
  }
  return counts;
}

export function projectChips(cards) {
  const chips = new Map();
  for (const card of cards ?? []) {
    const id = String(card?.project ?? "").trim() || "unknown";
    const chip = chips.get(id) ?? { id, label: id, count: 0, needsYou: false };
    chip.count += 1;
    if (card?.column === "needs_you") chip.needsYou = true;
    chips.set(id, chip);
  }
  return [...chips.values()].sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

// Archive is local presentation state keyed by workspace and immutable epic ID.
export function archiveKey(workspace, id) {
  return `${String(workspace ?? "")}\u0000${String(id ?? "")}`;
}

export function filterArchived(rows, archived, workspace) {
  const list = rows ?? [];
  if (!archived || typeof archived.has !== "function" || archived.size === 0) return list;
  return list.filter((row) => !archived.has(archiveKey(workspace, canonicalId(row))));
}

// The lowest line on a blocked agent's screen that asks a question. The same
// rule as the reference board: ignore chrome, shortcuts and bare prompts.
export function lastQuestion(screen) {
  const lines = String(screen ?? "").split("\n")
    .map((line) => line.replace(/^[\s│┃╭╰╮╯─━❯›>⎿⏺●•◆□☐✳*]+/u, "").trim())
    .reverse();
  const question = lines.find((line) => line.length >= 10 && /\p{L}/u.test(line)
    && /\?(\s|\)|$)/.test(line) && !line.startsWith("?") && !/shortcuts/i.test(line));
  if (!question) return "";
  return question.length > 160 ? `${question.slice(0, 159)}…` : question;
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
