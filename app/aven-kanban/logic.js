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
// LLM summaries share one contract with `aven-dispatch describe`: at most
// three short bullet lines, produced only for long descriptions. Short text
// keeps its existing presentation.
export const SUMMARY_LABEL = "LLM SUMMARY";
export const SUMMARY_MIN_CHARS = 100;
export const SUMMARY_MAX_BULLETS = 3;
export const SUMMARY_LIMIT = 600;
export const SUMMARY_BULLET_LIMIT = 180;
export const SUMMARY_CARD_LIMIT = 120;
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

// The reference Board palette. Kept here with the read model so contrast is
// testable without loading GPUI. Every text token is checked against the
// surfaces it is drawn on by test/aven-kanban.test.mjs.
export const BOARD_COLORS = {
  top: "#101012", side: "#0f0f11", main: "#121214", card: "#1a1a1d", raised: "#242328", hover: "#1f1f23",
  line: "#1e1e20", line2: "#2a2a30", text: "#e4e4e7", soft: "#c8c8cc", muted: "#a6a5ab", dim: "#8f8e95",
  accent: "#b4a0db", accentDim: "#8672b8",
  you: "#ffb406", youBg: "#1f1a10", youCard: "#1b1912", youAsk: "#241f12", youLine: "#4a3a12",
  work: "#8f7fd1", land: "#53cf91", landBg: "#12201a", landLine: "#1d3a2c", done: "#6fb3f2", red: "#e0707f",
};

// Foreground/background pairs that carry text at 9-22px, plus the selection
// and focus borders. WCAG AA: 4.5:1 for text, 3:1 for UI component boundaries.
export const TEXT_CONTRAST_PAIRS = [
  ["text", "main"], ["soft", "main"], ["muted", "main"], ["dim", "main"],
  ["text", "card"], ["soft", "card"], ["muted", "card"], ["dim", "card"],
  ["text", "top"], ["dim", "top"], ["muted", "raised"], ["dim", "raised"],
  ["accent", "top"], ["you", "youCard"], ["you", "youBg"], ["work", "card"],
  ["land", "card"], ["done", "card"], ["red", "card"], ["dim", "youAsk"],
];
export const BORDER_CONTRAST_PAIRS = [
  ["accent", "card"], ["accentDim", "card"], ["accentDim", "main"],
];

function channel(value) {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(foreground, background) {
  const parse = (hex) => {
    const value = String(hex ?? "").replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(value)) throw new Error(`contrast needs #rrggbb colors, got ${hex}`);
    return [0, 2, 4].map((offset) => channel(parseInt(value.slice(offset, offset + 2), 16)));
  };
  const luminance = ([red, green, blue]) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  const [light, dark] = [luminance(parse(foreground)), luminance(parse(background))].sort((left, right) => right - left);
  return (light + 0.05) / (dark + 0.05);
}

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

export function assertBoardCoverage({ available = 0, upcoming = 0, attempts = 0, epics = 0, obligations = 0 }) {
  if (available >= LIMIT || upcoming >= LIMIT || epics >= LIMIT || obligations >= LIMIT) throw new Error(`epic or obligation read reached the ${LIMIT}-item safety limit`);
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

// The board owns a project chip per project plus an `all` chip, so both reads
// span the whole workspace instead of letting Aven infer one project from the
// checkout directory. Qualified refs keep detail reads and handoffs working.
export function epicArgs(workspace) {
  return ["list", "--workspace", workspace, "--all-projects", "--epics", "--limit", String(LIMIT), "--json"];
}

export function upcomingArgs(workspace) {
  return ["list", "--workspace", workspace, "--all-projects", "--upcoming", "--limit", String(LIMIT), "--json"];
}

export function detailArgs(workspace, ref) {
  return ["show", ref, "--workspace", workspace, "--full", "--json"];
}

// The board's list reads stay workspace-wide, but its initial chip should name
// the project the selected Herdr space/worktree belongs to. Let Aven infer that
// project from the checkout instead of guessing from the folder name: linked
// worktrees, project path mappings, and same-named projects resolve exactly as
// they do for any other Aven command.
export function currentProjectArgs(workspace) {
  return ["list", "--workspace", workspace, "--limit", "1", "--json"];
}

// JSON rows are authoritative; Aven also prints its resolved scope on stderr
// when the bounded list is empty (for example a project with no tasks yet).
export function resolveCurrentProject(rows, stderr = "") {
  const keys = new Set((rows ?? [])
    .map((row) => String(row?.project?.key ?? row?.project ?? "").trim())
    .filter(Boolean));
  if (keys.size === 1) return [...keys][0];
  if (keys.size > 1) return "";
  const match = String(stderr ?? "").match(/^scope:\s*project\s+(\S+)\s+\(from /m);
  return match ? match[1] : "";
}

// Automatic selection never invents an empty board: a resolved project keeps
// the chip only while it has a card in the current view. Otherwise the board
// falls back to all, which still shows every workspace project.
export function automaticProjectFilter(project, rows) {
  const key = String(project ?? "").trim();
  if (!key) return "";
  return (rows ?? []).some((row) => String(row?.project ?? "").trim() === key) ? key : "";
}

// Delivery obligations are ordinary open tasks linked to their accepted source
// by `delivery.obligation-for`. One bounded list plus one detail read per open
// obligation is cheaper than reading every child phase of every epic.
export function obligationListArgs(workspace) {
  return ["list", "--workspace", workspace, "--all-projects", "--open",
    "--has-metadata", "delivery.obligation-for", "--limit", String(LIMIT), "--json"];
}

// Metadata that gates approval, delivery, or plan badges, plus the LLM summary
// contract the board renders. Everything else in an `aven show --full` payload
// stays outside the board model.
export const DETAIL_METADATA = [
  "sdd.plan-worked-out", "approval.state", "approval.id", "approval.commit", "approval.workflow",
  "delivery.state", "delivery.target", "delivery.obligation", "delivery.obligation-for",
  "summary.llm", "summary.llm.digest", "summary.llm.generated-at",
  "summary.llm.state", "summary.llm.state-at", "summary.llm.error",
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
    // Related tasks carry the delivery obligation and its live status. Keep
    // only identity and state; aven show never lets notes or extra fields leak
    // into the board model.
    related: Array.isArray(payload?.related) ? payload.related.map((linked) => ({
      id: String(linked?.task_id ?? linked?.id ?? ""),
      ref: String(linked?.ref ?? linked?.display_ref ?? ""),
      title: String(linked?.title ?? ""),
      status: String(linked?.status ?? ""),
      deleted: linked?.deleted === true,
    })) : [],
    description: String(payload?.description ?? ""),
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
    || Boolean(cached.detail?.metadata?.["approval.state"])
    || Boolean(cached.detail?.metadata?.["delivery.obligation"])
    || Boolean(cached.detail?.metadata?.["summary.llm"])
    || cached.detail?.metadata?.["summary.llm.state"] === "generating";
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

// A first paint may enrich progressively while no board exists yet. Refreshing
// an already-settled board instead stages hydration and delivery evidence and
// publishes once, so merged badges cannot flicker mid-refresh.
export function refreshMayPublishProgress(hasSettledBoard) {
  return !hasSettledBoard;
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

// Remaining open tasks prevent an accepted epic from becoming done. The
// dispatcher publishes one delivery obligation linked from `delivery.obligation`
// (and `delivery.obligation-for` on the obligation itself), while open child
// phases block closeout independently. Approval attaches obligations to
// accepted child phases, so the indexed child obligations are included too.
// Unrelated related links, such as dispatcher log tasks, are context rather
// than blockers, so only the named/indexed obligations and open children are
// surfaced.
export function openTaskBlockers({ children = [], related = [], obligation = "", obligations = [] } = {}) {
  const blockers = [];
  const seen = new Set();
  const add = (task, kind) => {
    const ref = String(task?.ref ?? task?.display_ref ?? "").trim();
    if (!ref || seen.has(ref)) return;
    if (task?.deleted === true) return;
    if (task?.open === false || TERMINAL_STATUSES.has(String(task?.status ?? ""))) return;
    seen.add(ref);
    blockers.push({
      ref,
      title: String(task?.title ?? "").trim(),
      status: String(task?.status ?? "").trim(),
      kind,
    });
  };
  const wanted = String(obligation ?? "").trim();
  const linked = wanted
    ? (related ?? []).find((task) => String(task?.ref ?? task?.display_ref ?? "").trim() === wanted)
    : null;
  // An obligation absent from `related` has unknown state, so it is not
  // invented as an open blocker.
  if (linked) add(linked, "delivery");
  for (const item of obligations ?? []) add(item, "delivery");
  for (const child of children ?? []) add(child, "phase");
  return blockers;
}

// Index open delivery obligations by the accepted source they belong to. The
// board only lists root epics, while approval attaches an obligation to each
// accepted child phase, so the root card needs the child's obligation too.
export function openObligationIndex(details) {
  const index = new Map();
  for (const detail of details ?? []) {
    const source = String(detail?.metadata?.["delivery.obligation-for"] ?? "").trim();
    const ref = String(detail?.task?.ref ?? "").trim();
    const status = String(detail?.task?.status ?? "").trim();
    if (!source || !ref || TERMINAL_STATUSES.has(status)) continue;
    if (!index.has(source)) index.set(source, []);
    index.get(source).push({
      ref,
      title: String(detail?.task?.title ?? "").trim(),
      status,
      kind: "delivery",
    });
  }
  return index;
}

function normalizedDescription(description) {
  return String(description ?? "").replace(/\r\n?/g, "\n").trim();
}

// 32-bit FNV-1a over UTF-16 code units, matching the Rust producer.
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

function clampText(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function cleanBullet(line, limit) {
  const text = String(line ?? "")
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clampText(text, limit);
}

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

export function taskSummary(task) {
  if (!summaryNeeded(task?.description)) return null;
  const summary = storedSummary(task?.metadata, task?.description);
  return summary ? { ...summary, label: SUMMARY_LABEL } : null;
}

// A card is the compact presentation of an already-derived task summary, so a
// caller that holds the task summary never recomputes its description digest.
export function cardFromSummary(summary) {
  if (!summary) return null;
  const lines = summaryLines(summary.text, SUMMARY_MAX_BULLETS, SUMMARY_CARD_LIMIT);
  return { ...summary, text: lines.join(" · "), lines };
}

export function cardSummary(task) {
  return cardFromSummary(taskSummary(task));
}

export const SUMMARY_GENERATING_TIMEOUT_MS = 10 * 60 * 1000;
export const SUMMARY_ERROR_RETRY_MS = 10 * 60 * 1000;

export function summaryState(metadata, now = Date.now()) {
  const state = String(metadata?.["summary.llm.state"] ?? "").trim();
  const at = Number(metadata?.["summary.llm.state-at"] ?? 0);
  const age = Number.isFinite(at) && at > 0 ? now - at : null;
  const generating = state === "generating" && (age === null || age < SUMMARY_GENERATING_TIMEOUT_MS);
  const errorCooling = state === "error" && age !== null && age >= 0 && age < SUMMARY_ERROR_RETRY_MS;
  return { state, at, age, generating, errorCooling };
}

// Terminal cards are final results; auto-summarizing them only restarts the
// board's refresh loop after the card has already settled.
export function autoSummaryCandidate(task, now = Date.now()) {
  if (TERMINAL_STATUSES.has(String(task?.status ?? ""))) return false;
  if (!summaryNeeded(task?.description)) return false;
  const summary = storedSummary(task?.metadata, task?.description);
  if (summary && !summary.stale) return false;
  const state = summaryState(task?.metadata, now);
  return !state.generating && !state.errorCooling;
}

// Normalize only the fields the board renders. In particular, dispatcher
// pending_prompt and Aven descriptions/notes never enter the view model.
export function normalizeEpic(row, detail, obligations = new Map()) {
  const id = canonicalId(row);
  const ref = qualifiedRef(row);
  if (!id || !ref || row?.deleted || row?.is_epic !== true) return null;
  const detailTask = detail?.task;
  const hydrated = detailTask?.id === id && detailTask?.is_epic === true;
  const metadata = hydrated && detail?.metadata && typeof detail.metadata === "object" ? detail.metadata : {};
  const children = hydrated && Array.isArray(detailTask.epic_children) ? detailTask.epic_children : (row.epic_children ?? []);
  const related = hydrated && Array.isArray(detail?.related) ? detail.related : [];
  const childIds = (Array.isArray(children) ? children : [])
    .map((child) => String(child?.id ?? "").trim())
    .filter(Boolean);
  const childRefs = (Array.isArray(children) ? children : [])
    .map((child) => String(child?.ref ?? "").trim())
    .filter(Boolean);
  const childObligations = childRefs.flatMap((childRef) => obligations?.get?.(childRef) ?? []);
  const status = String(hydrated && detailTask.status ? detailTask.status : (row.status ?? "unknown"));
  const approval = approvalMarker(hydrated ? metadata : {});
  const description = hydrated && typeof detail?.description === "string" ? detail.description : "";
  const summary = hydrated ? taskSummary({ description, metadata }) : null;
  const card = cardFromSummary(summary);
  const state = summaryState(metadata);
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
    summary: summary?.text ?? "",
    summaryCard: card?.text ?? "",
    summaryLines: card?.lines ?? [],
    summaryStale: Boolean(summary?.stale),
    summaryState: state.state,
    summaryGenerating: hydrated && state.generating,
    summaryAuto: hydrated && autoSummaryCandidate({ description, metadata, status }),
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
    openTasks: hydrated ? openTaskBlockers({
      children,
      related,
      obligation: metadata["delivery.obligation"] ?? "",
      obligations: childObligations,
    }) : [],
  };
}

export function mergeEpicRows({ available = [], upcoming = [], details = {}, obligations = new Map() }) {
  const rows = new Map();
  for (const raw of [...available, ...upcoming]) {
    const id = canonicalId(raw);
    if (!id || rows.has(id)) continue;
    const row = normalizeEpic(raw, details[id], obligations);
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
    sessionId: String(attempt?.session_id ?? attempt?.sessionId ?? ""),
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
// opens a pull request itself. It runs in the task's own session, so follow-up
// review changes stay with the worktree that owns the approved branch.
export function shipPrompt(epic) {
  if (!epic?.id) throw new Error("No approved task identity is available.");
  return `Ship the approved result for Aven task ${epic.id} as a pull request from this task's worktree and branch. Push only the approved task branch, open a pull request following the repository conventions, and keep any review follow-ups in this session. Do not merge, force-push, rewrite history, or change Aven acceptance. Report the pull request URL.`;
}

export function shipTabName(epic) {
  if (!epic?.ref) throw new Error("No approved task reference is available.");
  return `ship ${epic.ref}`;
}

// Herdr appends a tab's first message to the agent argv as its last token.
// OpenCode treats a bare positional argument as a project directory, so give
// it the supported --prompt flag for that trailing message instead.
export function handoffAgentRun(argv) {
  const run = Array.isArray(argv) ? argv : [];
  const program = String(run[0] ?? "").split(/[\\/]/).pop();
  if (program !== "opencode" || run.includes("--prompt")) return run;
  return [...run, "--prompt"];
}

export function handoffTabArgs({ name, space, folder, argv, task }) {
  if (!name || !space || !folder || !Array.isArray(argv) || argv.length === 0 || !task) {
    throw new Error("A task-space handoff tab needs a name, space, folder, agent, and prompt.");
  }
  return ["do", "tab.new", "--name", name, "--space", space, "--folder", folder,
    "--argv", JSON.stringify(handoffAgentRun(argv)), "--task", task];
}

// The live task terminal is the session that owns the approved result. For a
// cumulative-worktree epic the coordinator integrated the phases, so prefer it
// over any builder terminal; every other topology prefers the builder.
export function liveHandoffTerminal(attempt, liveAgents = [], terminals = []) {
  if (!attempt) return null;
  const refs = attempt.executionMode === "worktrees"
    ? [attempt.coordinatorTerminal, attempt.terminal]
    : [attempt.terminal, attempt.coordinatorTerminal];
  const observed = (attempt.terminals ?? [])
    .filter((item) => item?.role === "builder" || item?.role === "coordinator")
    .map((item) => item.address);
  const addresses = [...new Set([...refs.map((ref) => String(ref?.address ?? "")), ...observed].filter(Boolean))];
  // A live agent list is current evidence and already carries its space/tab.
  for (const address of addresses) {
    const agent = (liveAgents ?? []).find((candidate) => String(candidate?.address ?? "") === address);
    if (agent) return { address, space: String(agent.space ?? ""), tab: String(agent.tab ?? "") };
  }
  // A live terminal observation also carries the app placement labels. A
  // finished or removed terminal is never a valid handoff target.
  for (const address of addresses) {
    const terminal = (terminals ?? []).find((candidate) =>
      String(candidate?.address ?? "") === address && String(candidate?.state ?? "") === "live");
    if (terminal) return {
      address,
      space: String(terminal.labels?.["herdr.space"] ?? ""),
      tab: String(terminal.labels?.["herdr.tab"] ?? ""),
    };
  }
  return null;
}

export function handoffSendArgs(address, task) {
  const terminal = String(address ?? "");
  if (!terminal) throw new Error("A live task agent terminal is required.");
  if (!task) throw new Error("A handoff prompt is required.");
  return ["send", terminal, task];
}

function normalizedPath(value) {
  return String(value ?? "").replace(/\/+$/, "");
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

// A handoff belongs to the task's own worktree space, never the primary
// checkout. Prefer the visible space whose first tab actually lives in that
// worktree; `space.folder` is only a fallback when no live pane data exists.
// A missing task space fails closed rather than guessing another space.
export function selectWorktreeSpace(spaces, worktree, activeSpaceId = "", panes = []) {
  const list = spaces ?? [];
  const folder = normalizedPath(worktree);
  if (!folder) return null;
  const live = list.filter((space) => normalizedPath(firstPaneFolder(space, panes)) === folder);
  const configured = list.filter((space) => normalizedPath(space?.folder) === folder);
  const candidates = live.length ? live : configured;
  if (!candidates.length) return null;
  return candidates.find((space) => space?.id === activeSpaceId) ?? candidates[0];
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

  const openTasks = Array.isArray(epic.openTasks) ? epic.openTasks : [];
  const onMain = terminalStatus && epic.mergedOnMain === true;
  // A merge into local main verifies code ancestry, not delivery. Canceled epics
  // are already final; every other terminal card with an open blocker stays out
  // of Done until that task is done or canceled.
  const blockedAfterMerge = onMain && epic.status !== "canceled" && openTasks.length > 0;
  const deliveredByMain = onMain && !blockedAfterMerge;
  if (onMain && !RECORDED_DELIVERY_STATES.has(epic.deliveryState)) {
    warnings.push("On main; closeout not recorded.");
  }
  if (blockedAfterMerge) {
    warnings.push(`${openTasks.length} open task${openTasks.length === 1 ? "" : "s"} still ${openTasks.length === 1 ? "blocks" : "block"} done.`);
  }

  let column;
  if (deliveredByMain) column = "done";
  else if (blockedAfterMerge) column = "ready";
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
  const readyToMerge = column === "ready" && approved && epic.status === "done" && !onMain;
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

// Enter opens the card's current agent. A live terminal is focused directly;
// otherwise a durable attempt is reopened from its saved worktree and session.
// Terminal cards and cards without an attempt keep the plain Aven-open fallback
// and never restart work.
export function reopenTarget(card) {
  if (!card || card.status === "done" || card.status === "canceled") return null;
  const attempt = card.attempt;
  if (!attempt || !attempt.attemptId || !attempt.sessionId || !attempt.worktree) return null;
  return {
    ref: card.ref,
    workflow: String(attempt.workflow ?? ""),
    attemptId: attempt.attemptId,
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

// Project chips narrow the board that was already classified. Filtering after
// the build keeps one build as the source of truth for render, stats, and
// selection; an empty project is an identity.
export function filterBoardByProject(columns, project) {
  const key = String(project ?? "");
  if (!key) return columns ?? [];
  return (columns ?? []).map((column) => ({
    ...column,
    cards: (column?.cards ?? []).filter((card) => card.project === key),
  }));
}

// Locate the selected card by column and row. Column-aware navigation copies
// Aven's columns view instead of treating the five lanes as one list.
function locateSelection(columns, selectedId) {
  const list = columns ?? [];
  for (let column = 0; column < list.length; column += 1) {
    const cards = list[column]?.cards ?? [];
    const row = cards.findIndex((card) => card.id === selectedId);
    if (row >= 0) return { column, row, cards };
  }
  return null;
}

function firstNonEmpty(columns, last) {
  const list = columns ?? [];
  const order = last
    ? Array.from({ length: list.length }, (_, index) => list.length - 1 - index)
    : Array.from({ length: list.length }, (_, index) => index);
  for (const index of order) {
    const cards = list[index]?.cards ?? [];
    if (cards.length) return { column: index, card: last ? cards.at(-1) : cards[0] };
  }
  return null;
}

// Vertical movement wraps inside the current column. With no selection it
// starts at the first non-empty column's first card.
export function moveSelection(columns, selectedId, delta) {
  if (!flattenBoard(columns).length) return "";
  const located = locateSelection(columns, selectedId);
  if (!located) return firstNonEmpty(columns, delta < 0)?.card?.id ?? "";
  if (!located.cards.length || delta === 0) return selectedId;
  const step = delta < 0 ? -1 : 1;
  const distance = Math.min(Math.abs(delta), located.cards.length);
  const next = ((located.row + step * distance) % located.cards.length + located.cards.length) % located.cards.length;
  return located.cards[next].id;
}

// Horizontal movement skips empty columns, keeps the row where possible, and
// clamps to the target column's last card. At the board edge the selection
// stays put, as in Aven.
export function moveHorizontal(columns, selectedId, delta) {
  if (delta === 0) return selectedId;
  const list = columns ?? [];
  const direction = delta < 0 ? -1 : 1;
  const located = locateSelection(list, selectedId);
  if (!located) return (direction < 0 ? firstNonEmpty(list, true) : firstNonEmpty(list, false))?.card?.id ?? "";
  for (let column = located.column + direction; column >= 0 && column < list.length; column += direction) {
    const cards = list[column]?.cards ?? [];
    if (cards.length) return cards[Math.min(located.row, cards.length - 1)].id;
  }
  return selectedId;
}

// First/last card in the focused column; global first/last when nothing is
// selected. This is Aven's gg/G and Home/End behaviour.
export function moveEdge(columns, selectedId, last) {
  const located = locateSelection(columns, selectedId);
  if (located) return located.cards.length ? located.cards[last ? located.cards.length - 1 : 0].id : "";
  return firstNonEmpty(columns, last)?.card?.id ?? "";
}

// Number keys jump to a column. An empty target falls back to the nearest
// non-empty column (lower index wins ties), matching Aven's nearest-lane move.
export function jumpToColumn(columns, selectedId, index) {
  const list = columns ?? [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return selectedId ?? "";
  const candidates = list
    .map((column, columnIndex) => ({ columnIndex, cards: column?.cards ?? [] }))
    .filter((entry) => entry.cards.length)
    .sort((left, right) => Math.abs(left.columnIndex - index) - Math.abs(right.columnIndex - index) || left.columnIndex - right.columnIndex);
  const target = candidates[0];
  if (!target) return "";
  const row = locateSelection(list, selectedId)?.row ?? 0;
  return target.cards[Math.min(row, target.cards.length - 1)].id;
}

// Tab and Shift-Tab move one column at a time; they share the h/l semantics.
export function moveColumn(columns, selectedId, delta) {
  return moveHorizontal(columns, selectedId, delta);
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
