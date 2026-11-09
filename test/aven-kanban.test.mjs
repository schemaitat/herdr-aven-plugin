import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATTEMPT_LIMIT, BOARD_COLORS, BOARD_COLUMNS, BORDER_CONTRAST_PAIRS, CREATED_FILTERS, DETAIL_METADATA, DISPATCH_ACTIONS, LIMIT,
  MERGE_PROMPT, SUMMARY_CARD_LIMIT, SUMMARY_ERROR_RETRY_MS, SUMMARY_LABEL, TEXT_CONTRAST_PAIRS, autoSummaryCandidate,
  approvalMarker, archiveKey, assertBoardCoverage, attemptNeedsYou, automaticProjectFilter, blockedAddress, boardStats, buildBoard,
  cardArchiveable, cardForEpic, cardFromSummary, cardSummary, contrastRatio, createdCutoff, currentProjectArgs, detailArgs, detailCacheKey, detailIsCurrent,
  detailNeedsRefresh, dispatchTerminalName, enrichmentPending, epicArgs, filterArchived, filterBoardByProject, filterRowsByCreated, flattenBoard,
  hydrateDetails, indexAttempts, isLiveEpicTerminal, jumpToColumn, landedWeek, lastQuestion, mapLimit, safeDetail,
  handoffAgentRun, handoffSendArgs, handoffTabArgs, liveAgentFor, liveHandoffTerminal, markMergedOnMain,
  mergeApprovalIssue, mergeEpicRows, mergePrompt, mergeTabName, moveColumn, moveEdge, moveHorizontal, moveSelection,
  nextMove, normalizeAttempt, normalizeEpic, obligationListArgs, openObligationIndex, openTaskBlockers, openArgs,
  projectChips, refreshMayPublishProgress, reopenTarget, resolveCurrentProject, selectAttempt, selectedCard,
  selectWorktreeSpace, shipPrompt, shipTabName,
  summaryDigest, summaryNeeded, summaryState, taskSummary, terminalName, upcomingArgs,
} from "../app/aven-kanban/logic.js";

const manifest = JSON.parse(readFileSync(new URL("../app/aven-kanban/mod.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.overlay, { width: 1, height: 1 }, "the board fills the app window");

// The top-bar refresh control must not change its measured content while a
// refresh is in flight. Keep the label constant and the spinner slot fixed.
const kanbanSource = readFileSync(new URL("../app/aven-kanban/main.js", import.meta.url), "utf8");
assert.equal(kanbanSource.includes("Refreshing…"), false, "refreshing never swaps the button label");
assert.match(kanbanSource, /refreshButton\(cx\)/, "the top bar uses the stable refresh control");
assert.match(kanbanSource, /aven-kanban-refresh-spinner/, "the refresh control owns a fixed spinner slot");
assert.match(kanbanSource, /w\(8\)\.h\(8\)\.flex_none\(\)/, "the spinner slot keeps a constant size");
assert.match(kanbanSource, /child\("Refresh"\)/, "the refresh label is constant");
assert.match(kanbanSource, /STILL OPEN/, "ready-to-ship cards name the remaining blockers");
assert.match(kanbanSource, /card\.openTasks/, "the card renders the open-task read model");

// A settled board must be replaced atomically: intermediate hydration and
// ancestry publishes would flip merged/main badges while the refresh runs.
assert.equal(refreshMayPublishProgress(false), true, "the first paint may enrich progressively");
assert.equal(refreshMayPublishProgress(true), false, "a settled board is replaced atomically");
assert.match(kanbanSource, /const progressive = refreshMayPublishProgress\(this\.hasSettledBoard\)/);
assert.match(kanbanSource, /if \(progressive\) this\.publishRows/);
assert.match(kanbanSource, /this\.mainMerged = mainEvidence\.merged;/);
assert.match(kanbanSource, /this\.hasSettledBoard = true;/);

// One render takes one live snapshot and builds the board once. The drawn,
// project-filtered columns then drive selection, stats, and chips instead of a
// second build or a per-card live lookup.
assert.match(kanbanSource, /snapshotLive\(\)/, "a render snapshots live agents, terminals, and tab times once");
assert.match(kanbanSource, /relatedAgentCache = new Map\(\)/, "each snapshot clears the related-agent memo");
assert.match(kanbanSource, /this\.selected\(columns\)/, "render reuses the drawn board for selection");
assert.match(kanbanSource, /const columns = filterBoardByProject\(board, this\.projectFilter\)/, "the project filter narrows the one built board");
assert.match(kanbanSource, /chips\(board, allStats, cx\)/, "chips reuse the stats the render already computed");
assert.doesNotMatch(kanbanSource, /this\.times\(\)\.get\(/, "no card falls back to a live tab-time read");

// Needs-you terminal reads and the checkout wait must not serialize behind
// process spawns: the reads share the bounded pool and the wait uses the app
// timer.
assert.match(kanbanSource, /QUESTION_WORKERS = 3/, "question reads use a small fixed pool");
assert.match(kanbanSource, /mapLimit\(cards, QUESTION_WORKERS/, "question reads share the bounded pool");
assert.doesNotMatch(kanbanSource, /for \(const card of cards\)/, "question reads are not a serial loop");
assert.match(kanbanSource, /taskCx\.sleep\(200\)/, "the checkout wait uses the app timer");
assert.doesNotMatch(kanbanSource, /exec\("sleep"/, "refresh no longer spawns a sleep process");

const rawEpic = (id, status = "todo", extra = {}) => ({
  id, ref: `HAP-${id}`, title: `Epic ${id}`, project: "herdr-aven-plugin", status,
  is_epic: true, deleted: false, created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z", epic_children: [], ...extra,
});
const detail = (row, metadata = {}, extra = {}) => ({
  task: { ...row, ...extra }, metadata,
});
const fullApproval = {
  "approval.state": "approved", "approval.id": "approval_one",
  "approval.commit": "abc123", "approval.workflow": "implementation",
};
const attempt = (taskId, extra = {}) => ({
  task_id: taskId, task_ref: `HAP-${taskId}`, workflow: "implementation", attempt_id: `att-${taskId}`,
  generation: 0, created_at: 100, state: "running", execution_mode: "single-session",
  worktree: "/repo/result", branch: "ignored-for-identity", lifecycle: { contradiction: "" },
  terminal: { address: "t-builder", core_id: "core", name: "builder" },
  coordinator_terminal: { address: "t-coordinator", core_id: "core", name: "coordinator" },
  pending_prompt: "must not enter the board model", ...extra,
});
const card = (status = "todo", metadata = {}, attempts = [], extra = {}, liveAgents = []) => {
  const row = rawEpic("ONE", status, extra);
  const epic = normalizeEpic(row, detail(row, metadata));
  return cardForEpic(epic, selectAttempt(attempts, epic.id), attempts, liveAgents);
};

assert.deepEqual(epicArgs("default"), ["list", "--workspace", "default", "--all-projects", "--epics", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(upcomingArgs("default"), ["list", "--workspace", "default", "--all-projects", "--upcoming", "--limit", String(LIMIT), "--json"]);
// The board resolves the selected space's project through Aven's own cwd
// inference; the read must stay bounded and must not widen to every project.
assert.deepEqual(currentProjectArgs("default"), ["list", "--workspace", "default", "--limit", "1", "--json"]);
assert.equal(resolveCurrentProject([{ project: "herdr-aven-plugin" }]), "herdr-aven-plugin");
assert.equal(resolveCurrentProject([{ project: { key: "herdr-aven-plugin" } }]), "herdr-aven-plugin");
assert.equal(resolveCurrentProject([{ project: "one" }, { project: "two" }]), "", "an unexpected multi-project read is not a resolution");
assert.equal(resolveCurrentProject([], "scope: project herdr-aven-plugin (from git root name) · --all-projects for everything\n"), "herdr-aven-plugin",
  "Aven's resolved scope fills an empty bounded read");
assert.equal(resolveCurrentProject([], "Error: error unknown-project input=probe\n"), "", "an inference error leaves the board on all");
assert.equal(resolveCurrentProject([], ""), "");
assert.equal(automaticProjectFilter("herdr-aven-plugin", [{ project: "herdr-aven-plugin" }]), "herdr-aven-plugin");
assert.equal(automaticProjectFilter("herdr-aven-plugin", [{ project: "other" }]), "", "a project with no visible card falls back to all");
assert.equal(automaticProjectFilter("herdr-aven-plugin", []), "");
assert.equal(automaticProjectFilter("", [{ project: "herdr-aven-plugin" }]), "");
assert.match(kanbanSource, /currentProjectArgs\(workspace\)/, "the board reads Aven's inferred project on every refresh");
assert.match(kanbanSource, /aven-kanban\.project-auto/, "an explicit chip choice is persisted separately from automatic resolution");
assert.match(kanbanSource, /automaticProjectFilter\(/, "automatic selection checks the visible cards");
assert.deepEqual(detailArgs("default", "HAP-ONE"), ["show", "HAP-ONE", "--workspace", "default", "--full", "--json"]);
assert.deepEqual(DISPATCH_ACTIONS.map(({ detailKey }) => detailKey), ["d", "s", "p", "i", "r", "x", "b"]);
assert.deepEqual(BOARD_COLUMNS.map(({ id }) => id), ["backlog", "needs_you", "working", "ready", "done"]);
assert.deepEqual(BOARD_COLUMNS.map(({ title }) => title), ["BACKLOG", "NEEDS YOU", "WORKING", "READY TO LAND", "DONE"]);
assert.deepEqual(BOARD_COLUMNS.map(({ tone }) => tone), ["dim", "attention", "working", "land", "done"]);
assert.deepEqual(CREATED_FILTERS.map(({ id }) => id), ["all", "1w", "2w", "1mo", "1y"]);
assert.deepEqual(CREATED_FILTERS.map(({ days }) => days), [null, 7, 14, 30, 365]);
assert.doesNotThrow(() => assertBoardCoverage({ available: LIMIT - 1, upcoming: LIMIT - 1, attempts: ATTEMPT_LIMIT - 1, epics: LIMIT - 1, obligations: LIMIT - 1 }));
assert.throws(() => assertBoardCoverage({ available: LIMIT }), /epic or obligation read reached/);
assert.throws(() => assertBoardCoverage({ upcoming: LIMIT }), /epic or obligation read reached/);
assert.throws(() => assertBoardCoverage({ epics: LIMIT }), /epic or obligation read reached/, "merged available/upcoming coverage is capped before metadata hydration");
assert.throws(() => assertBoardCoverage({ obligations: LIMIT }), /epic or obligation read reached/, "the open-obligation read is capped too");
assert.throws(() => assertBoardCoverage({ attempts: ATTEMPT_LIMIT }), /dispatcher read reached/);

// Creation filters hide cards outside the selected lookback; unknown dates are
// kept only in "all" rather than being presented as recent.
const now = Date.parse("2026-11-06T00:00:00Z");
const aged = [
  rawEpic("W1", "todo", { created_at: "2026-11-01T00:00:00Z" }),
  rawEpic("W2", "todo", { created_at: "2026-10-25T00:00:00Z" }),
  rawEpic("MO", "todo", { created_at: "2026-10-10T00:00:00Z" }),
  rawEpic("Y", "todo", { created_at: "2026-02-01T00:00:00Z" }),
  rawEpic("OLD", "todo", { created_at: "2024-01-01T00:00:00Z" }),
  rawEpic("BAD", "todo", { created_at: "not-a-date" }),
];
assert.deepEqual(filterRowsByCreated(aged, "all", now).map(({ id }) => id), ["W1", "W2", "MO", "Y", "OLD", "BAD"]);
assert.deepEqual(filterRowsByCreated(aged, "1w", now).map(({ id }) => id), ["W1"]);
assert.deepEqual(filterRowsByCreated(aged, "2w", now).map(({ id }) => id), ["W1", "W2"]);
assert.deepEqual(filterRowsByCreated(aged, "1mo", now).map(({ id }) => id), ["W1", "W2", "MO"]);
assert.deepEqual(filterRowsByCreated(aged, "1y", now).map(({ id }) => id), ["W1", "W2", "MO", "Y"]);
assert.equal(createdCutoff("all", now), 0);
assert.equal(createdCutoff("1w", now), now - 7 * 86_400_000);
assert.deepEqual(filterRowsByCreated(aged, "bogus", now), aged, "an unknown filter is treated as all");

// List normalization retains every nondeleted epic, including terminal and
// scheduled rows, while dropping ordinary tasks and deduplicating upcoming.
const plannedRow = rawEpic("PLANNED");
const merged = mergeEpicRows({
  available: [
    rawEpic("OLD", "done", { updated_at: "2025-01-01T00:00:00Z" }),
    rawEpic("TASK", "todo", { is_epic: false }),
    rawEpic("GONE", "todo", { deleted: true }),
    plannedRow,
  ],
  upcoming: [plannedRow, rawEpic("FUTURE", "backlog", { available_at: "2027-01-01T00:00:00Z" })],
  details: { PLANNED: detail(plannedRow, { "sdd.plan-worked-out": "true", ...fullApproval, "delivery.target": "main" }) },
});
assert.deepEqual(merged.map(({ id }) => id), ["FUTURE", "PLANNED", "OLD"]);
const planned = merged.find(({ id }) => id === "PLANNED");
assert.equal(planned.planWorkedOut, true);
assert.equal(planned.approved, false, "a marker on a non-done task is not usable approval");
assert.equal(planned.approvalId, "approval_one");
assert.equal(planned.hydrated, true);
assert.equal(planned.deliveryTarget, "main");
assert.deepEqual(planned.taskIds, ["PLANNED"]);
assert.equal(normalizeEpic(plannedRow).hydrated, false, "missing detail is unknown, not evidence of an unplanned/delivered task");
const mismatched = normalizeEpic(plannedRow, detail(rawEpic("OTHER"), { "sdd.plan-worked-out": "true", "approval.state": "approved" }));
assert.equal(mismatched.hydrated, false, "detail IDs must corroborate list identity");
assert.equal(mismatched.planWorkedOut, false);
assert.equal(mismatched.approved, false);
const withPhases = rawEpic("PHASES", "active", { epic_children: [
  { id: "A", status: "done", open: false }, { id: "B", status: "active", open: true }, { id: "C", status: "canceled", open: false },
] });
assert.deepEqual(normalizeEpic(withPhases).phases, { complete: 2, total: 3 });
assert.deepEqual(normalizeEpic(withPhases).taskIds, ["PHASES", "A", "B", "C"]);

// LLM summaries use the same contract as the sidebar: long descriptions only,
// a shared digest for staleness, and a bounded card presentation.
const longText = "a".repeat(101);
assert.equal(SUMMARY_LABEL, "LLM SUMMARY");
assert.equal(summaryDigest("hello"), "4f9f2cab");
assert.equal(summaryDigest("héllo ☃"), "f57826aa");
assert.equal(summaryNeeded("a".repeat(100)), false);
assert.equal(summaryNeeded("a".repeat(101)), true);
assert.equal(taskSummary({ description: "short", metadata: { "summary.llm": "x" } }), null, "the shared helper keeps short text raw");
const summaryRow = rawEpic("SUM", "todo", {});
const summaryDetail = {
  task: { ...summaryRow },
  description: longText,
  metadata: {
    "summary.llm": "- First point.\n- Second point.\n- Third point.\n- Fourth point.",
    "summary.llm.digest": summaryDigest(longText),
  },
};
const summarized = normalizeEpic(summaryRow, summaryDetail);
const summaryText = "First point.\nSecond point.\nThird point.";
assert.equal(summarized.summary, summaryText);
assert.deepEqual(summarized.summaryLines, ["First point.", "Second point.", "Third point."]);
assert.equal(summarized.summaryCard, "First point. · Second point. · Third point.");
assert.equal(summarized.summaryStale, false);
const staleSummary = normalizeEpic(summaryRow, {
  ...summaryDetail,
  metadata: { ...summaryDetail.metadata, "summary.llm.digest": "deadbeef" },
});
assert.equal(staleSummary.summaryStale, true);
assert.equal(staleSummary.summary, summaryText, "a stale summary is still shown");
assert.equal(normalizeEpic(summaryRow, { ...summaryDetail, description: "short" }).summary, "", "short descriptions never surface a summary");
assert.equal(normalizeEpic(summaryRow).summary, "", "unhydrated cards have no summary");
assert.equal(
  cardSummary({ description: longText, metadata: { "summary.llm": "x".repeat(500), "summary.llm.digest": summaryDigest(longText) } }).lines[0].length,
  SUMMARY_CARD_LIMIT,
  "card summary lines are bounded",
);
const derivedSummary = taskSummary({
  description: longText,
  metadata: { "summary.llm": summaryText, "summary.llm.digest": summaryDigest(longText) },
});
assert.deepEqual(
  cardFromSummary(derivedSummary),
  cardSummary({ description: longText, metadata: { "summary.llm": summaryText, "summary.llm.digest": summaryDigest(longText) } }),
  "a card reuses the task summary that was already derived",
);
assert.equal(cardFromSummary(null), null, "no task summary produces no card summary");
const summaryCard = cardForEpic(summarized, selectAttempt([], "SUM"));
assert.equal(summaryCard.summaryCard, "First point. · Second point. · Third point.");
assert.equal(summaryCard.column, "backlog");
assert.equal(summarized.summaryAuto, false, "a current summary is not auto-generated");
const missingSummary = normalizeEpic(summaryRow, { task: { ...summaryRow }, description: longText, metadata: {} });
assert.equal(missingSummary.summaryAuto, true, "a long description without a summary is queued");
assert.equal(
  autoSummaryCandidate({ status: "active", description: longText, metadata: {} }, Date.now()),
  true,
  "open work remains eligible for a background summary",
);
for (const status of ["done", "canceled"]) {
  const terminalRow = rawEpic(status.toUpperCase(), status);
  const terminalSummary = normalizeEpic(terminalRow, {
    task: { ...terminalRow }, description: longText, metadata: {},
  });
  assert.equal(terminalSummary.summaryAuto, false, `a ${status} epic is never queued for a background summary`);
  assert.equal(
    autoSummaryCandidate({ status, description: longText, metadata: {} }, Date.now()),
    false,
    `the ${status} status is rejected before description length is considered`,
  );
}
const staleTerminalRow = rawEpic("STALETERM", "done");
const staleTerminal = normalizeEpic(staleTerminalRow, {
  task: { ...staleTerminalRow }, description: longText,
  metadata: { "summary.llm": summaryText, "summary.llm.digest": "deadbeef" },
});
assert.equal(staleTerminal.summaryStale, true, "a terminal card keeps its stale marker for manual repair");
assert.equal(staleTerminal.summaryAuto, false, "a stale terminal summary is not regenerated by the board");
const generatingSummary = normalizeEpic(summaryRow, {
  task: { ...summaryRow },
  description: longText,
  metadata: { "summary.llm.state": "generating", "summary.llm.state-at": String(Date.now()) },
});
assert.equal(generatingSummary.summaryGenerating, true);
assert.deepEqual(generatingSummary.summaryLines, []);
assert.equal(generatingSummary.summaryAuto, false, "an active run is not queued again");
const erroredSummary = normalizeEpic(summaryRow, {
  task: { ...summaryRow },
  description: longText,
  metadata: { "summary.llm.state": "error", "summary.llm.state-at": String(Date.now()) },
});
assert.equal(erroredSummary.summaryAuto, false, "a recent failure cools down");
const oldErroredSummary = normalizeEpic(summaryRow, {
  task: { ...summaryRow },
  description: longText,
  metadata: { "summary.llm.state": "error", "summary.llm.state-at": String(Date.now() - SUMMARY_ERROR_RETRY_MS - 1000) },
});
assert.equal(oldErroredSummary.summaryAuto, true, "an old failure is retryable");
assert.equal(summaryState({ "summary.llm.state": "generating", "summary.llm.state-at": String(Date.now()) }).generating, true);
assert.equal(
  detailNeedsRefresh({ workspace: "default", updatedAt: "t1", detail: { task: { status: "active" }, metadata: { "summary.llm.state": "generating" } } }, "default", { updated_at: "t1" }),
  true,
  "a generating state is re-read even when the second-granular timestamp matches",
);
assert.equal(
  detailNeedsRefresh({ workspace: "default", updatedAt: "t1", detail: { task: { status: "active" }, metadata: { "summary.llm": "x" } } }, "default", { updated_at: "t1" }),
  true,
  "summary metadata is re-read even when the second-granular timestamp matches",
);
assert.equal(
  detailNeedsRefresh({ workspace: "default", updatedAt: "t1", detail: { task: { status: "active" }, metadata: { "delivery.obligation": "HAP-OB" } } }, "default", { updated_at: "t1" }),
  true,
  "obligation-sensitive details are re-read even when the second-granular timestamp matches",
);

// Every lifecycle column and the independent acceptance/execution/delivery facts.
assert.equal(card("inbox").column, "backlog");
assert.equal(card("backlog").column, "backlog");
assert.equal(card("todo").column, "backlog");
assert.equal(card("todo", { "sdd.plan-worked-out": "true" }).column, "backlog", "planned-out stays in intake with a badge");
assert.equal(card("active", { "sdd.plan-worked-out": "true" }).column, "working");
assert.equal(card("todo", { "sdd.plan-worked-out": "true" }, [attempt("ONE")]).column, "working", "execution moves a planned card without editing Aven");
assert.equal(card("todo", {}, [attempt("ONE", { state: "failed" })]).column, "working");
assert.equal(card("todo", {}, [attempt("ONE", { state: "interrupted" })]).column, "working");
assert.equal(card("active", {}, [attempt("ONE", { state: "needs-review" })]).column, "ready");
assert.equal(card("active", {}, [attempt("ONE", { state: "completed" })]).column, "ready");
assert.equal(card("done", {}, [attempt("ONE", { state: "needs-review" })]).column, "ready");
assert.equal(card("done", { "delivery.state": "pending" }).column, "ready");
assert.equal(card("done", { "delivery.state": "committed" }).column, "ready");
assert.equal(card("done", { "delivery.state": "merged" }).column, "done");
assert.equal(card("done").column, "done", "legacy accepted work stays Done when no pending delivery fact exists");
assert.equal(card("canceled").column, "done");
const mainMerged = card("done", {}, [attempt("ONE", { state: "needs-review" })], { mergedOnMain: true });
assert.equal(mainMerged.column, "done", "exact local-main ancestry moves terminal work out of Ready despite stale execution");
assert.match(mainMerged.warnings.join(" "), /closeout not recorded/, "unrecorded closeout remains visible");
assert.equal(card("done", { "delivery.state": "pending" }, [], { mergedOnMain: true }).column, "done", "main ancestry satisfies pending delivery presentation for terminal work");
assert.equal(card("canceled", {}, [attempt("ONE", { state: "interrupted" })], { mergedOnMain: true }).column, "done");
assert.equal(card("active", { "delivery.state": "pending" }, [], { mergedOnMain: true }).column, "ready", "an active epic cannot be closed from code ancestry alone (HAP-SZ57)");
assert.equal(card("done", {}, [attempt("ONE", { state: "needs-review" })]).column, "ready", "unmerged terminal work remains Ready to land");
// A merge into local main only verifies code ancestry. An open task still
// blocking delivery keeps the card in Ready to land and closes merge actions,
// because the approved result is already on main.
const blockerCard = (metadata, related, children = [], status = "done", obligations = new Map()) => {
  const row = rawEpic("ONE", status, { epic_children: children });
  const epic = normalizeEpic(row, { task: { ...row }, metadata, related }, obligations);
  return cardForEpic({ ...epic, mergedOnMain: true }, selectAttempt([], epic.id), []);
};
const mergedBlocked = blockerCard(
  { ...fullApproval, "delivery.state": "committed", "delivery.obligation": "HAP-OB" },
  [{ ref: "HAP-OB", title: "Manual main integration", status: "todo" }],
);
assert.equal(mergedBlocked.column, "ready", "a merged result with an open blocker is not Done");
assert.equal(mergedBlocked.mergeable, false, "already-merged work is not offered a second merge");
assert.equal(mergedBlocked.openTasks[0].title, "Manual main integration");
assert.match(mergedBlocked.warnings.join(" "), /1 open task still blocks done/);
const mergedClear = blockerCard(
  { ...fullApproval, "delivery.state": "committed", "delivery.obligation": "HAP-OB" },
  [{ ref: "HAP-OB", title: "Manual main integration", status: "done" }],
);
assert.equal(mergedClear.column, "done", "a resolved obligation returns the card to Done");
assert.doesNotMatch(mergedClear.warnings.join(" "), /still block done/);
const mergedChildBlocked = blockerCard({ "delivery.state": "committed" }, [{ ref: "HAP-CH", status: "todo" }], [{ id: "CH", ref: "HAP-CH", status: "todo", open: true }]);
assert.equal(mergedChildBlocked.column, "ready", "an accepted epic with an open child is not Done");
const mergedChildObligation = blockerCard(
  { ...fullApproval, "delivery.state": "committed" },
  [],
  [{ id: "CH", ref: "HAP-CH", title: "child", status: "done", open: false }],
  "done",
  openObligationIndex([{ task: { ref: "HAP-COB", title: "Manual main check", status: "todo" }, metadata: { "delivery.obligation-for": "HAP-CH" } }]),
);
assert.equal(mergedChildObligation.column, "ready", "a done child's open obligation still blocks the root");
assert.equal(mergedChildObligation.openTasks[0].ref, "HAP-COB");
assert.equal(card("canceled", {}, [], { mergedOnMain: true }).column, "done", "canceled work stays final");
const canceledBlocked = blockerCard({ "delivery.state": "committed" }, [], [{ id: "CH", ref: "HAP-CH", status: "todo", open: true }], "canceled");
assert.equal(canceledBlocked.column, "done", "open children never reopen canceled work");
// Before ancestry evidence lands, terminal work without an approval waits in
// Done instead of claiming Ready to land; approved review work keeps its card.
const pendingAncestry = (status, metadata, attempts) => {
  const row = rawEpic("ONE", status);
  const epic = normalizeEpic(row, detail(row, metadata));
  return cardForEpic({ ...epic, ancestryPending: true }, selectAttempt(attempts, epic.id), attempts, []);
};
assert.equal(pendingAncestry("done", {}, [attempt("ONE", { state: "needs-review" })]).column, "done", "provisional terminal work stays Done until ancestry is known");
assert.equal(pendingAncestry("done", fullApproval, [attempt("ONE", { state: "needs-review" })]).column, "ready", "approved review work is provisional Ready to land");
assert.equal(pendingAncestry("done", {}, []).mergedOnMain, false);
const marked = markMergedOnMain([normalizeEpic(rawEpic("ONE", "done")), normalizeEpic(rawEpic("TWO", "done"))], new Set(["ONE"]));
assert.equal(marked[0].mergedOnMain, true);
assert.equal(marked[1].mergedOnMain, false);
assert.equal(card("done", {}, [attempt("ONE", { state: "running", lifecycle: { contradiction: "terminal_live_execution" } })]).column, "ready");
assert.match(card("done", {}, [attempt("ONE", { state: "running", lifecycle: { contradiction: "terminal_live_execution" } })]).warnings.join(" "), /conflicts with active execution/);
const unhydratedRow = rawEpic("UNKNOWN");
assert.match(cardForEpic(normalizeEpic(unhydratedRow), selectAttempt([], unhydratedRow.id)).warnings.join(" "), /Plan metadata/, "unhydrated todo is labeled rather than presented as certainly unplanned");

// NEEDS YOU is live blocked evidence on a working card, never an Aven edit.
const blockedTerminals = { builder: { address: "t-builder", state: "live", status: "blocked" } };
const workingTerminals = { builder: { address: "t-builder", state: "live", status: "working" } };
assert.equal(attemptNeedsYou(normalizeAttempt(attempt("ONE", { terminals: blockedTerminals }))), true);
assert.equal(attemptNeedsYou(normalizeAttempt(attempt("ONE", { terminals: workingTerminals }))), false);
assert.equal(attemptNeedsYou(normalizeAttempt(attempt("ONE")), [{ address: "t-builder", status: "blocked" }]), true);
assert.equal(attemptNeedsYou(normalizeAttempt(attempt("ONE")), [{ address: "t-builder", status: "working" }]), false);
assert.equal(attemptNeedsYou(null), false);
assert.deepEqual(liveAgentFor(normalizeAttempt(attempt("ONE")), [{ address: "t-builder", status: "blocked" }]), { address: "t-builder", status: "blocked" });
const multipleAgents = [{ address: "t-builder", status: "working" }, { address: "t-coordinator", status: "blocked" }];
assert.equal(attemptNeedsYou(normalizeAttempt(attempt("ONE")), multipleAgents), true);
assert.equal(blockedAddress([normalizeAttempt(attempt("ONE"))], multipleAgents), "t-coordinator");
assert.equal(blockedAddress([normalizeAttempt(attempt("ONE", { terminals: { child: { address: "t-child", state: "live", status: "blocked" } } }))]), "t-child");
assert.equal(liveAgentFor(normalizeAttempt(attempt("ONE")), [{ address: "t-coordinator", status: "blocked" }]).address, "t-coordinator", "coordinator terminals count as related agents");
const needsCard = card("active", {}, [attempt("ONE", { terminals: blockedTerminals })]);
assert.equal(needsCard.column, "needs_you");
assert.equal(needsCard.needsYou, true);
assert.equal(card("active", {}, [attempt("ONE", { terminals: blockedTerminals })], {}, [{ address: "t-builder", status: "blocked" }]).column, "needs_you");
assert.equal(card("active", {}, [attempt("ONE", { terminals: workingTerminals })]).column, "working");
assert.notEqual(card("done", {}, [attempt("ONE", { terminals: blockedTerminals })]).column, "needs_you", "terminal work is never needs-you");
assert.equal(card("done", {}, [attempt("ONE", { terminals: blockedTerminals })], { mergedOnMain: true }).column, "done");
const ambiguousBlocked = cardForEpic(
  normalizeEpic(rawEpic("ONE", "active"), detail(rawEpic("ONE", "active"))),
  selectAttempt([
    attempt("ONE", { attempt_id: "one", created_at: 100, terminals: blockedTerminals }),
    attempt("ONE", { attempt_id: "two", created_at: 100, terminals: blockedTerminals }),
  ], "ONE"),
  [attempt("ONE", { terminals: blockedTerminals })],
);
assert.equal(ambiguousBlocked.column, "working", "ambiguous attempts keep dispatch paused instead of claiming needs-you");

// Approval is the merge gate, not execution or a live builder terminal.
const approvedReview = card("done", { ...fullApproval, "delivery.state": "committed" });
assert.equal(approvedReview.column, "ready");
assert.equal(approvedReview.approved, true);
assert.equal(approvedReview.approvalId, "approval_one");
assert.equal(approvedReview.readyToMerge, true);
assert.equal(approvedReview.mergeable, true);
assert.equal(card("done", { ...fullApproval, "delivery.state": "committed" }, []).mergeable, true, "approval survives a finished builder terminal");
assert.equal(card("done", { "delivery.state": "committed" }).approved, false);
assert.equal(card("done", { "delivery.state": "committed" }).mergeable, false, "pending delivery alone is not approval");
assert.equal(card("active", {}, [attempt("ONE", { state: "needs-review" })]).mergeable, false, "review execution alone is not approval");
assert.equal(card("done", { ...fullApproval, "delivery.state": "merged" }).mergeable, false, "delivered work is not mergeable");
assert.equal(card("canceled", { ...fullApproval, "delivery.state": "pending" }).mergeable, false, "canceled work is never mergeable");

// The dispatcher requires the durable marker, not just approval.state. A
// state-only marker must stay out of ready-to-merge and explain why.
assert.deepEqual(approvalMarker({ "approval.state": "approved" }), {
  state: "approved", id: "", commit: "", workflow: "", approved: false, incomplete: true,
});
const stateOnly = card("done", { "approval.state": "approved", "delivery.state": "committed" });
assert.equal(stateOnly.column, "ready");
assert.equal(stateOnly.approved, false);
assert.equal(stateOnly.approvalIncomplete, true);
assert.equal(stateOnly.readyToMerge, false);
assert.equal(stateOnly.mergeable, false);
assert.match(stateOnly.warnings.join(" "), /incomplete/);
const partial = card("done", { ...fullApproval, "approval.id": "", "delivery.state": "committed" });
assert.equal(partial.mergeable, false, "a missing approval id blocks the merge action");
assert.equal(normalizeEpic(rawEpic("ONE", "done"), detail(rawEpic("ONE", "done"), fullApproval)).approved, true);
assert.equal(mergeApprovalIssue({ status: "done" }, fullApproval), "", "a complete marker may open the merge handoff");
assert.match(mergeApprovalIssue({ status: "done" }, { "approval.state": "approved" }), /approval\.id/, "the fresh merge gate names a missing approval id");
assert.match(mergeApprovalIssue({ status: "active" }, fullApproval), /status=active/, "the fresh merge gate rejects a non-done task");
assert.match(mergeApprovalIssue({ status: "done" }, {}), /state=missing/, "the fresh merge gate rejects a missing marker");
const nonDoneApproval = card("active", fullApproval);
assert.equal(nonDoneApproval.approved, false, "an approval marker on a non-done task is invalid");
assert.equal(nonDoneApproval.approvalInvalid, true);
assert.equal(nonDoneApproval.readyToMerge, false);

// Hydrated details are workspace-scoped and must be re-read after a change or
// a failed read rather than reusing a stale approval snapshot.
assert.equal(detailCacheKey("default", "ONE"), "default\u0000ONE");
assert.notEqual(detailCacheKey("default", "ONE"), detailCacheKey("notes", "ONE"));
const cachedDetail = { workspace: "default", updatedAt: "t1", detail: detail(rawEpic("ONE", "done"), fullApproval) };
assert.equal(detailIsCurrent(cachedDetail, "default", { updated_at: "t1" }), true);
assert.equal(detailIsCurrent(cachedDetail, "notes", { updated_at: "t1" }), false, "a detail from another workspace is never current");
assert.equal(detailIsCurrent(cachedDetail, "default", { updated_at: "t2" }), false, "a changed row is re-read");
assert.equal(detailIsCurrent(undefined, "default", { updated_at: "t1" }), false, "a failed/absent read has no current snapshot");
const sameSecondApproval = { workspace: "default", updatedAt: "t1", detail: { task: { status: "done" }, metadata: fullApproval } };
assert.equal(detailNeedsRefresh(sameSecondApproval, "default", { updated_at: "t1" }), true, "approval-sensitive cards are re-read even when second-granular timestamps collide");
const sameSecondActive = { workspace: "default", updatedAt: "t1", detail: { task: { status: "active" }, metadata: {} } };
assert.equal(detailNeedsRefresh(sameSecondActive, "default", { updated_at: "t1" }), false, "ordinary unchanged cards stay cached");
assert.equal(detailNeedsRefresh(sameSecondActive, "notes", { updated_at: "t1" }), true, "a workspace change forces a re-read");
assert.equal(detailNeedsRefresh(undefined, "default", { updated_at: "t1" }), true, "a failed/absent read is retried");

// Agent activity covers the root and every child task, but failed/interrupted
// work is not presented as actively running.
assert.equal(card("active", {}, [attempt("ONE", { state: "running" })]).agentActive, true);
assert.equal(card("active", {}, [attempt("ONE", { state: "failed" })]).agentActive, false);
assert.equal(card("active", {}, [attempt("ONE", { state: "interrupted" })]).agentActive, false);
const childRoot = rawEpic("ROOT", "active", { epic_children: [{ id: "CHILD", status: "active", open: true }] });
const childEpic = normalizeEpic(childRoot, detail(childRoot, {}));
assert.equal(cardForEpic(childEpic, selectAttempt([], "ROOT"), [attempt("CHILD", { state: "running" })]).agentActive, true);
assert.equal(cardForEpic(childEpic, selectAttempt([], "ROOT"), [attempt("CHILD", { state: "failed" })]).agentActive, false);
assert.equal(cardForEpic(childEpic, selectAttempt([], "ROOT"), [attempt("CHILD", { state: "completed" })]).agentActive, false);
assert.equal(cardForEpic(childEpic, selectAttempt([], "ROOT"), [attempt("CHILD", { state: "running" })], [{ address: "t-builder", status: "working" }]).agentActive, true, "live working agents corroborate activity");

// A read-only summary can expose a checkpoint that was never reduced after its
// terminals stopped. Recorded terminals and stopped observations are evidence.
const finishedTerminals = { builder: { address: "t-builder", state: "finished", status: "" } };
const liveTerminals = { builder: { address: "t-builder", state: "live", status: "working" } };
assert.deepEqual(normalizeAttempt(attempt("ONE", { terminals: finishedTerminals })).terminals,
  [{ role: "builder", address: "t-builder", state: "finished", status: "" }]);
assert.equal(normalizeAttempt(attempt("ONE", { lifecycle: { observation: "stopped-success", contradiction: "" } })).observation, "stopped-success");
assert.equal(card("active", {}, [attempt("ONE", { state: "running", terminals: finishedTerminals })]).agentActive, false,
  "a running checkpoint whose role terminals all stopped is stale");
assert.equal(card("active", {}, [attempt("ONE", { state: "running", terminals: liveTerminals })]).agentActive, true,
  "a live role terminal keeps the activity signal");
assert.equal(card("active", {}, [attempt("ONE", { state: "running", lifecycle: { observation: "stopped-success", contradiction: "" } })]).agentActive, false,
  "a stopped lifecycle observation never pulses");
const staleDone = card("done", {}, [attempt("ONE", { state: "terminal-pending", terminals: finishedTerminals })], { mergedOnMain: true });
assert.equal(staleDone.column, "done");
assert.equal(staleDone.agentActive, false, "done work whose terminals stopped must not pulse working");
assert.match(staleDone.warnings.join(" "), /closeout not recorded/);
assert.doesNotMatch(staleDone.warnings.join(" "), /conflicts with active execution/,
  "an unreconciled pending checkpoint is not active execution");
// A read-only summary can retain a dispatch-time `live` observation for an
// attempt that was never reconciled after acceptance. Without a live herdr
// agent, that checkpoint is stale evidence, not active execution.
const storedLiveDone = card("done", {}, [attempt("ONE", { state: "running", terminals: liveTerminals })]);
assert.equal(storedLiveDone.column, "done",
  "an unreconciled stored-live checkpoint does not move accepted work to Ready");
assert.doesNotMatch(storedLiveDone.warnings.join(" "), /conflicts with active execution/,
  "a stored-live checkpoint alone is not active execution");
const liveDone = card("done", {}, [attempt("ONE", { state: "terminal-pending", terminals: liveTerminals })],
  { mergedOnMain: true }, [{ address: "t-builder", status: "working" }]);
assert.equal(liveDone.agentActive, false, "terminal epics are inert for the working pulse");
assert.match(liveDone.warnings.join(" "), /conflicts with active execution/,
  "a live working agent keeps genuine activity visible as a contradiction");
assert.equal(card("done", {}, [attempt("ONE", { state: "terminal-pending", terminals: liveTerminals })],
  { mergedOnMain: true }).warnings.join(" ").includes("conflicts with active execution"), false,
  "the same stored-live card without live agent evidence stays quiet");
const stopped = attempt("ONE", { state: "completed", terminals: finishedTerminals });
assert.equal(cardForEpic(normalizeEpic(rawEpic("ONE", "active"), detail(rawEpic("ONE", "active"), {})),
  selectAttempt([stopped], "ONE"), [stopped], [{ address: "t-builder", status: "working" }]).agentActive, true,
  "a live working agent is current evidence even after the stored state stopped");

// Attempt identity and ordering never use branch, focus, ref, or worktree.
const selected = selectAttempt([
  attempt("OTHER", { state: "needs-review", created_at: 9999 }),
  attempt("ONE", { attempt_id: "old", generation: 0, created_at: 900 }),
  attempt("ONE", { attempt_id: "new", generation: 1, created_at: 100 }),
  attempt("ONE", { attempt_id: "unrelated", generation: 0, created_at: 9999 }),
], "ONE");
assert.equal(selected.attempt.attemptId, "new", "reset generation outranks older/newer timestamps within an older generation");
assert.equal(selected.ambiguous, false);
const ambiguous = selectAttempt([
  attempt("ONE", { attempt_id: "one", created_at: 100 }),
  attempt("ONE", { attempt_id: "two", created_at: 100 }),
], "ONE");
assert.equal(ambiguous.attempt, null);
assert.equal(ambiguous.ambiguous, true);
const duplicate = selectAttempt([attempt("ONE"), attempt("ONE")], "ONE");
assert.equal(duplicate.ambiguous, false, "duplicate observations of one attempt do not fabricate ambiguity");
const safeAttempt = normalizeAttempt(attempt("ONE"));
assert.equal("pending_prompt" in safeAttempt, false);
assert.equal("prompt" in safeAttempt, false);
assert.equal(normalizeAttempt(attempt("ONE", { session_id: "ses-one" })).sessionId, "ses-one",
  "the durable OpenCode session id is available to the reopen decision");
assert.equal(normalizeAttempt(attempt("ONE", { sessionId: "ses-camel" })).sessionId, "ses-camel");
assert.equal(normalizeAttempt(attempt("ONE", { session_id: "" })).sessionId, "");

// Enter reopens only a non-terminal card that still owns a durable attempt.
const runningCard = card("active", {}, [attempt("ONE", { session_id: "ses-one" })]);
assert.deepEqual(reopenTarget(runningCard), {
  ref: "HAP-ONE", workflow: "implementation", attemptId: "att-ONE",
}, "a running attempt with a worktree and session is reopenable");
assert.deepEqual(reopenTarget(card("backlog", {}, [attempt("ONE", { execution_mode: "worktrees", session_id: "ses-c", worktree: "/repo/coord" })])),
  { ref: "HAP-ONE", workflow: "implementation", attemptId: "att-ONE" },
  "an attempt without a live terminal still offers reopen from any open card column");
assert.equal(reopenTarget(card("active", {}, [])), null, "no attempt keeps the Aven fallback");
assert.equal(reopenTarget(card("active", {}, [attempt("ONE", { session_id: "" })])), null,
  "an attempt without a durable session is not reopened");
assert.equal(reopenTarget(card("active", {}, [attempt("ONE", { worktree: "" })])), null,
  "an attempt without a worktree is not reopened");
assert.equal(reopenTarget(card("done", {}, [attempt("ONE", { session_id: "ses-one" })])), null,
  "accepted work is never restarted");
assert.equal(reopenTarget(card("canceled", {}, [attempt("ONE", { session_id: "ses-one" })])), null,
  "canceled work is never restarted");
assert.equal(reopenTarget(null), null);

// The board must actually use that decision and never start a terminal itself.
assert.match(kanbanSource, /reopenAgent\(card, cx\)/, "Enter routes to the reopen action");
assert.match(kanbanSource, /exec\("aven-dispatch", args\)/, "the board asks the dispatcher to reopen");
assert.match(kanbanSource, /\["reopen", target\.ref, "--json"\]/, "reopen is non-interactive and machine-readable");
assert.match(kanbanSource, /pendingLaunches\.has\(identity\)/, "duplicate reopen launches are suppressed");
assert.match(kanbanSource, /Reopening \$\{this\.reopening\}'s agent session/, "the board shows the reopen in progress");
assert.match(kanbanSource, /this\.open\(card, taskCx\)/, "a failed reopen still falls back to the epic in Aven");
assert.match(kanbanSource, /attempt\.coordinatorTerminal\?\.address/, "a worktree coordinator terminal is focusable");

// Merge and Ship PR are prompts delivered to the task's own agent session.
const approvedEpic = normalizeEpic(rawEpic("ONE", "done"), detail(rawEpic("ONE", "done"), fullApproval));
assert.equal(mergePrompt(approvedEpic), `${MERGE_PROMPT} ONE`);
assert.equal(mergeTabName(approvedEpic), "merge HAP-ONE");
// Herdr appends the task as a positional argument. OpenCode takes a starting
// prompt through --prompt; a bare positional is a project directory.
assert.deepEqual(handoffAgentRun(["opencode"]), ["opencode", "--prompt"]);
assert.deepEqual(handoffAgentRun(["/opt/opencode/bin/opencode"]), ["/opt/opencode/bin/opencode", "--prompt"]);
assert.deepEqual(handoffAgentRun(["opencode", "--prompt"]), ["opencode", "--prompt"]);
assert.deepEqual(handoffAgentRun(["claude"]), ["claude"], "non-OpenCode agents keep positional prompts");
assert.deepEqual(handoffAgentRun(["opencode", "--model", "x"]), ["opencode", "--model", "x", "--prompt"]);
assert.deepEqual(handoffTabArgs({
  name: "merge HAP-ONE", space: "sp-task", folder: "/worktrees/task", argv: ["opencode"], task: `${MERGE_PROMPT} ONE`,
}), [
  "do", "tab.new", "--name", "merge HAP-ONE", "--space", "sp-task", "--folder", "/worktrees/task",
  "--argv", '["opencode","--prompt"]', "--task", `${MERGE_PROMPT} ONE`,
]);
assert.deepEqual(handoffTabArgs({
  name: "merge HAP-ONE", space: "sp-task", folder: "/worktrees/task", argv: ["claude"], task: `${MERGE_PROMPT} ONE`,
})[9], '["claude"]', "handoff args leave a positional-prompt agent unchanged");
assert.throws(() => handoffTabArgs({ name: "", space: "sp-task", folder: "/worktrees/task", argv: ["opencode"], task: "x" }), /needs a name/);
assert.throws(() => handoffTabArgs({ name: "n", space: "", folder: "/worktrees/task", argv: ["opencode"], task: "x" }), /needs a name/);
assert.throws(() => mergePrompt({}), /No approved task identity/);
assert.throws(() => mergeTabName({ id: "ONE" }), /No approved task reference/);

// A handoff prompt is typed into the exact live task terminal.
assert.deepEqual(handoffSendArgs("t-builder", `${MERGE_PROMPT} ONE`), ["send", "t-builder", `${MERGE_PROMPT} ONE`]);
assert.throws(() => handoffSendArgs("", "prompt"), /live task agent terminal/);
assert.throws(() => handoffSendArgs("t-builder", ""), /prompt is required/);

// Single-session work prefers its builder; a worktree epic prefers the
// coordinator that integrated the phases, even when a builder is also live.
const builderAttempt = normalizeAttempt(attempt("ONE", { execution_mode: "single-session", coordinator_terminal: { address: "", core_id: "", name: "" } }));
const coordinatorAttempt = normalizeAttempt(attempt("ONE", { execution_mode: "worktrees" }));
const liveAgents = [
  { address: "t-builder", space: "sp-task", tab: "tb-builder" },
  { address: "t-coordinator", space: "sp-task", tab: "tb-coordinator" },
];
assert.deepEqual(liveHandoffTerminal(builderAttempt, liveAgents, []),
  { address: "t-builder", space: "sp-task", tab: "tb-builder" });
assert.deepEqual(liveHandoffTerminal(coordinatorAttempt, liveAgents, []),
  { address: "t-coordinator", space: "sp-task", tab: "tb-coordinator" },
  "worktree epics hand off to the coordinator, not a live builder");
assert.equal(liveHandoffTerminal(builderAttempt, [{ address: "t-other", space: "sp-other" }], []), null,
  "an unrelated live agent is never a handoff target");
assert.deepEqual(liveHandoffTerminal(builderAttempt, [], [
  { address: "t-builder", state: "live", labels: { "herdr.space": "sp-task", "herdr.tab": "tb-builder" } },
]), { address: "t-builder", space: "sp-task", tab: "tb-builder" });
assert.equal(liveHandoffTerminal(builderAttempt, [], [
  { address: "t-builder", state: "finished", labels: { "herdr.space": "sp-task" } },
]), null, "a finished terminal address is never used");
assert.equal(liveHandoffTerminal(normalizeAttempt(attempt("ONE", {
  terminal: { address: "", core_id: "", name: "" },
  coordinator_terminal: { address: "", core_id: "", name: "" },
  terminals: { builder: { address: "t-builder", state: "live" } },
})), [], [{ address: "t-builder", state: "live", labels: {} }])?.address, "t-builder",
  "a recorded role observation can still identify the live builder");
assert.equal(liveHandoffTerminal(null, liveAgents, []), null);

// The fallback tab belongs to the attempt worktree's visible space, never the
// primary checkout. A live first pane wins over a stale configured folder.
const taskSpaces = [
  { id: "task1", folder: "/worktrees/task", name: "task" },
  { id: "task2", folder: "/worktrees/task", name: "task copy" },
  { id: "main", folder: "/repo", name: "repo" },
];
assert.equal(selectWorktreeSpace(taskSpaces, "/worktrees/task", "", []).id, "task1");
assert.equal(selectWorktreeSpace(taskSpaces, "/worktrees/task/", "task2", []).id, "task2",
  "the active matching task space wins");
assert.equal(selectWorktreeSpace(taskSpaces, "/worktrees/missing", "", []), null,
  "an unknown worktree never falls back to main");
assert.equal(selectWorktreeSpace([{ id: "main", folder: "/repo" }], "/worktrees/task", "", []), null);
assert.equal(selectWorktreeSpace([], "/worktrees/task", "", []), null);
assert.equal(selectWorktreeSpace(taskSpaces, "", "task1", []), null);
const liveSpaces = [
  { id: "task", folder: "/stale", name: "task", tabs: [{ id: "task-tab", index: 1 }] },
  { id: "main", folder: "/worktrees/task", name: "repo", tabs: [{ id: "main-tab", index: 1 }] },
];
const livePanes = [
  { tab: "main-tab", cwd: "/repo" },
  { tab: "task-tab", cwd: "/worktrees/task" },
];
assert.equal(selectWorktreeSpace(liveSpaces, "/worktrees/task", "", livePanes).id, "task",
  "the first tab's live worktree folder wins over a stale space.folder");

// Board order, per-refresh immutable-ID indexing, keyboard selection, and exact terminal identity.
const attemptIndex = indexAttempts([attempt("B", { state: "needs-review" }), attempt("OTHER")]);
assert.deepEqual([...attemptIndex.keys()].sort(), ["B", "OTHER"]);
assert.equal(attemptIndex.get("B")[0].attemptId, "att-B");
assert.equal("pending_prompt" in attemptIndex.get("B")[0], false);
const boardRows = ["A", "B", "C", "D", "E"].map((id) => rawEpic(id));
const board = buildBoard({ rows: boardRows, attemptIndex });
assert.equal(flattenBoard(board).length, 5);
assert.equal(board.find(({ id }) => id === "ready").cards[0].id, "B");
const ordered = flattenBoard(board).map(({ id }) => id);
const first = moveSelection(board, "", 1);
assert.equal(first, ordered[0]);
assert.equal(moveSelection(board, first, 1), ordered[1], "vertical order stays inside the backlog column");
assert.equal(moveSelection([], "", 1), "");

// Vim navigation copies Aven's columns view: wrap inside a column, skip empty
// columns horizontally, clamp the row, and keep the board edge.
const navColumns = [
  { id: "backlog", cards: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] },
  { id: "needs_you", cards: [] },
  { id: "working", cards: [{ id: "c1" }, { id: "c2" }] },
  { id: "ready", cards: [] },
  { id: "done", cards: [{ id: "e1" }] },
];
assert.equal(moveSelection(navColumns, "a1", 1), "a2");
assert.equal(moveSelection(navColumns, "a3", 1), "a1", "next wraps inside the column");
assert.equal(moveSelection(navColumns, "a1", -1), "a3", "previous wraps inside the column");
assert.equal(moveSelection(navColumns, "", 1), "a1");
assert.equal(moveSelection(navColumns, "", -1), "e1", "unselected previous starts at the global last");
assert.equal(moveSelection(navColumns, "missing", 1), "a1");
assert.equal(moveSelection(navColumns, "a1", 0), "a1");

assert.equal(moveHorizontal(navColumns, "a1", 1), "c1", "empty columns are skipped");
assert.equal(moveHorizontal(navColumns, "a2", 1), "c2", "the row is preserved");
assert.equal(moveHorizontal(navColumns, "a3", 1), "c2", "the row clamps to the target column");
assert.equal(moveHorizontal(navColumns, "c2", 1), "e1");
assert.equal(moveHorizontal(navColumns, "e1", 1), "e1", "the board edge keeps the selection");
assert.equal(moveHorizontal(navColumns, "a1", -1), "a1");
assert.equal(moveHorizontal(navColumns, "c1", -1), "a1", "previous skips empty columns");
assert.equal(moveHorizontal(navColumns, "", 1), "a1");
assert.equal(moveHorizontal(navColumns, "", -1), "e1");
assert.equal(moveColumn(navColumns, "a2", 1), "c2", "Tab shares horizontal movement");

assert.equal(moveEdge(navColumns, "a2", false), "a1");
assert.equal(moveEdge(navColumns, "a2", true), "a3");
assert.equal(moveEdge(navColumns, "c1", true), "c2");
assert.equal(moveEdge(navColumns, "", false), "a1");
assert.equal(moveEdge(navColumns, "", true), "e1");
assert.equal(moveEdge([], "", false), "");

assert.equal(jumpToColumn(navColumns, "a2", 2), "c2", "the row survives a column jump");
assert.equal(jumpToColumn(navColumns, "a2", 1), "a2", "an empty target uses the nearest non-empty lane");
assert.equal(jumpToColumn(navColumns, "a2", 3), "c2", "ties and empty targets prefer the nearest lane");
assert.equal(jumpToColumn(navColumns, "a2", 4), "e1");
assert.equal(jumpToColumn(navColumns, "a2", 9), "a2", "an out-of-range column keeps the selection");
assert.equal(jumpToColumn([], "", 0), "");

// Contrast is part of the read model so the palette cannot regress silently.
assert.equal(contrastRatio("#000000", "#ffffff").toFixed(0), "21");
assert.throws(() => contrastRatio("red", "#ffffff"), /rrggbb/);
for (const [foreground, background] of TEXT_CONTRAST_PAIRS) {
  const ratio = contrastRatio(BOARD_COLORS[foreground], BOARD_COLORS[background]);
  assert.ok(ratio >= 4.5, `${foreground} on ${background} is ${ratio.toFixed(2)}:1; text needs 4.5:1`);
}
for (const [foreground, background] of BORDER_CONTRAST_PAIRS) {
  const ratio = contrastRatio(BOARD_COLORS[foreground], BOARD_COLORS[background]);
  assert.ok(ratio >= 3, `${foreground} on ${background} is ${ratio.toFixed(2)}:1; a control border needs 3:1`);
}

assert.equal(selectedCard(board, "B").column, "ready");
assert.equal(selectedCard(board, "missing"), null);

// Project narrowing filters the board that was already built, keeping one
// build as the source of truth for render, stats, and selection.
const projectBoard = buildBoard({
  rows: [rawEpic("ALPHA"), rawEpic("BETA", "todo", { project: "other" })],
  attemptIndex: new Map(),
});
const alphaBoard = filterBoardByProject(projectBoard, "herdr-aven-plugin");
assert.deepEqual(alphaBoard.map(({ id }) => id), BOARD_COLUMNS.map(({ id }) => id), "every column survives the filter");
assert.deepEqual(flattenBoard(alphaBoard).map(({ id }) => id), ["ALPHA"]);
assert.equal(filterBoardByProject(projectBoard, ""), projectBoard, "an empty project filter is an identity");
assert.deepEqual(flattenBoard(filterBoardByProject(projectBoard, "missing")), []);
const childBoard = buildBoard({ rows: [childEpic], attemptIndex: indexAttempts([attempt("CHILD", { state: "running" })]) });
assert.equal(flattenBoard(childBoard)[0].agentActive, true, "child attempts pulse the root card");

const epic = { id: "ONE", ref: "HAP-ONE" };
const name = `${terminalName("default", epic.id)}test`;
assert.ok(name.length <= 32);
assert.notEqual(terminalName("default", epic.id), terminalName("other", epic.id));
assert.equal(isLiveEpicTerminal({ state: "live", name }, "default", epic.id), true);
assert.equal(isLiveEpicTerminal({ state: "finished", name }, "default", epic.id), false);
assert.deepEqual(openArgs({ workspace: "default", epic, cwd: "/repo", name }).slice(-6), ["--", "aven", "--workspace", "default", "tui", "HAP-ONE"]);
assert.equal(openArgs({ workspace: "default", epic, cwd: "", name }).includes("--cwd"), false);
assert.ok(dispatchTerminalName("default", epic.id, DISPATCH_ACTIONS[1]).startsWith(terminalName("default", epic.id)));
assert.ok(dispatchTerminalName("default", epic.id, DISPATCH_ACTIONS[1]).endsWith("-s-"));

// Strip, project chips and NEXT MOVE derive only from the board that is drawn.
const statsColumns = [
  { id: "backlog", cards: [{ id: "a", updated_at: "2026-01-01T00:00:00Z" }, { id: "b", updated_at: "2026-01-02T00:00:00Z" }] },
  { id: "needs_you", cards: [{ id: "c", updated_at: "2026-01-03T00:00:00Z" }, { id: "d", updated_at: "2026-01-02T00:00:00Z" }] },
  { id: "working", cards: [{ id: "e" }] },
  { id: "ready", cards: [{ id: "f" }] },
  { id: "done", cards: [{ id: "g" }, { id: "h" }, { id: "i" }] },
];
assert.deepEqual(boardStats(statsColumns), {
  total: 9, backlog: 2, needsYou: 2, working: 1, ready: 1, done: 3, open: 6,
});
assert.deepEqual(boardStats([]), { total: 0, backlog: 0, needsYou: 0, working: 0, ready: 0, done: 0, open: 0 });
assert.equal(nextMove(statsColumns).id, "d", "the oldest needs-you card owns the banner");
assert.equal(nextMove([{ id: "backlog", cards: [{ id: "a" }] }]), null);
const weekNow = Date.parse("2026-11-06T12:00:00Z");
assert.deepEqual(landedWeek([
  { mergedOnMain: true, updated_at: "2026-11-06T01:00:00Z" },
  { deliveryState: "merged", updated_at: "2026-11-05T01:00:00Z" },
  { mergedOnMain: true, updated_at: "2026-10-20T01:00:00Z" },
  { mergedOnMain: false, deliveryState: "pending", updated_at: "2026-11-06T01:00:00Z" },
], weekNow), [0, 0, 0, 0, 0, 1, 1]);
assert.deepEqual(landedWeek([], weekNow), [0, 0, 0, 0, 0, 0, 0]);
const chips = projectChips([
  { project: "beta", column: "working" },
  { project: "alpha", column: "needs_you" },
  { project: "beta", column: "done" },
  { project: "", column: "backlog" },
]);
assert.deepEqual(chips.map(({ id }) => id), ["beta", "alpha", "unknown"]);
assert.equal(chips[0].count, 2);
assert.equal(chips[1].needsYou, true);
assert.equal(chips[1].count, 1);

// Archive hides only the same workspace's immutable IDs and never edits Aven.
assert.equal(archiveKey("default", "ONE"), "default\u0000ONE");
assert.notEqual(archiveKey("default", "ONE"), archiveKey("other", "ONE"));
const archived = new Set([archiveKey("default", "ONE")]);
assert.deepEqual(filterArchived([rawEpic("ONE"), rawEpic("TWO")], archived, "default").map(({ id }) => id), ["TWO"]);
assert.deepEqual(filterArchived([rawEpic("ONE")], archived, "other").map(({ id }) => id), ["ONE"], "another workspace is untouched");
assert.equal(filterArchived([rawEpic("ONE")], new Set(), "default").length, 1);
assert.equal(filterArchived([rawEpic("ONE")], null, "default").length, 1);

// The question parser takes the lowest question, ignores chrome and shortcuts.
assert.equal(lastQuestion(""), "");
assert.equal(lastQuestion("│ Merge PR #43 as is, or split the cleanup out?\n❯ "), "Merge PR #43 as is, or split the cleanup out?");
assert.equal(lastQuestion("First question here?\nsecond question here?\n"), "second question here?");
assert.equal(lastQuestion("Shortcuts: press ? for help"), "");
assert.equal(lastQuestion("? just a prompt"), "");
const longQuestion = `${"a".repeat(180)}?`;
assert.equal(lastQuestion(longQuestion).length, 160);
assert.ok(lastQuestion(longQuestion).endsWith("…"));

// Ship PR is a separate, explicit agent handoff in the task's own worktree,
// never a Git mutation and never a primary-checkout instruction.
const shipText = shipPrompt({ id: "ONE" });
assert.match(shipText, /Aven task ONE/);
assert.match(shipText, /pull request/);
assert.match(shipText, /task's worktree and branch/);
assert.match(shipText, /review follow-ups/);
assert.doesNotMatch(shipText, /primary checkout/);
assert.doesNotMatch(shipText, /\/ha-merge/);
assert.equal(shipTabName({ ref: "HAP-ONE" }), "ship HAP-ONE");
assert.throws(() => shipPrompt({}), /No approved task identity/);
assert.throws(() => shipTabName({ id: "ONE" }), /No approved task reference/);
assert.equal(handoffTabArgs({
  name: shipTabName({ ref: "HAP-ONE" }), space: "sp-task", folder: "/worktrees/task",
  argv: ["opencode"], task: shipPrompt({ id: "ONE" }),
})[0], "do");

// Detail normalization keeps only the approval/delivery/plan and LLM summary
// metadata the board renders, including trimmed child identity fields.
assert.deepEqual(DETAIL_METADATA, [
  "sdd.plan-worked-out", "approval.state", "approval.id", "approval.commit", "approval.workflow",
  "delivery.state", "delivery.target", "delivery.obligation", "delivery.obligation-for",
  "summary.llm", "summary.llm.digest", "summary.llm.generated-at",
  "summary.llm.state", "summary.llm.state-at", "summary.llm.error",
]);
assert.deepEqual(obligationListArgs("default"), [
  "list", "--workspace", "default", "--all-projects", "--open",
  "--has-metadata", "delivery.obligation-for", "--limit", String(LIMIT), "--json",
]);
const sanitized = safeDetail({
  task: {
    id: "ONE", ref: "HAP-ONE", title: "Epic", status: "done", is_epic: true,
    description: "must not leak", epic_children: [{ id: "C", ref: "HAP-C", title: "Child", status: "done", open: false, note: "x" }],
  },
  description: "long body",
  metadata: { "approval.state": "approved", "approval.id": 42, "delivery.state": "pending", "summary.llm": "- point", secret: "no" },
  notes: [{ body: "must not leak" }],
});
assert.deepEqual(sanitized.metadata, { "approval.state": "approved", "delivery.state": "pending", "summary.llm": "- point" });
assert.equal(sanitized.description, "long body");
assert.equal("description" in sanitized.task, false);
assert.equal("notes" in sanitized, false);
assert.deepEqual(sanitized.task.epic_children, [{ id: "C", ref: "HAP-C", title: "Child", status: "done", open: false }]);
const sanitizedRelated = safeDetail({
  task: { id: "ONE", ref: "HAP-ONE", title: "Epic", status: "done", is_epic: true },
  related: [
    { task_id: "OB", display_ref: "HAP-OB", title: "Manual main integration", status: "todo", deleted: false, note: "must not leak", metadata: { secret: "no" } },
    { task_id: "LOG", display_ref: "DL-ONE", title: "Dispatch log", status: "active" },
  ],
  description: "",
  metadata: {},
});
assert.deepEqual(sanitizedRelated.related, [
  { id: "OB", ref: "HAP-OB", title: "Manual main integration", status: "todo", deleted: false },
  { id: "LOG", ref: "DL-ONE", title: "Dispatch log", status: "active", deleted: false },
], "related tasks are sanitized to identity and state");
assert.deepEqual(safeDetail({}).related, [], "a missing related list is empty");

// Remaining open tasks are the named delivery obligation plus open children,
// never unrelated context links or terminal/deleted rows.
const obligation = { ref: "HAP-OB", title: "Manual main integration", status: "todo" };
assert.deepEqual(openTaskBlockers({
  obligation: "HAP-OB",
  related: [obligation, { ref: "DL-ONE", title: "Dispatch log", status: "active" }, { ref: "HAP-DONE", title: "done", status: "done" }],
  children: [
    { ref: "HAP-C1", title: "child one", status: "active", open: true },
    { ref: "HAP-C2", title: "child two", status: "done", open: false },
    { ref: "HAP-OB", title: "duplicate", status: "todo" },
    { ref: "HAP-DEL", title: "deleted child", status: "todo", deleted: true },
  ],
}), [
  { ref: "HAP-OB", title: "Manual main integration", status: "todo", kind: "delivery" },
  { ref: "HAP-C1", title: "child one", status: "active", kind: "phase" },
], "the obligation comes first, children follow, duplicates and terminal rows are dropped");
assert.deepEqual(openTaskBlockers({ obligation: "HAP-MISSING", related: [] }), [],
  "an obligation absent from related has unknown state and is not invented");
assert.deepEqual(openTaskBlockers({ obligation: "HAP-CANCELED", related: [{ ref: "HAP-CANCELED", status: "canceled" }] }), [],
  "a canceled obligation no longer blocks");
const childObligations = [{ ref: "HAP-COB", title: "Manual main check", status: "todo", kind: "delivery" }];
assert.deepEqual(openTaskBlockers({
  obligation: "HAP-OB",
  related: [obligation],
  obligations: childObligations,
  children: [{ ref: "HAP-OB", title: "child with same ref", status: "active", open: true }],
}).map(({ ref }) => ref), ["HAP-OB", "HAP-COB"], "child obligations follow the root obligation and dedupe shared refs");
const obligationIndex = openObligationIndex([
  { task: { ref: "HAP-OB", title: "Manual main integration", status: "todo" }, metadata: { "delivery.obligation-for": "HAP-CHILD" } },
  { task: { ref: "HAP-DONE", title: "done", status: "done" }, metadata: { "delivery.obligation-for": "HAP-CHILD" } },
  { task: { ref: "HAP-NOSOURCE", title: "bad", status: "todo" }, metadata: {} },
]);
assert.deepEqual(obligationIndex.get("HAP-CHILD"), [{ ref: "HAP-OB", title: "Manual main integration", status: "todo", kind: "delivery" }]);
assert.equal(obligationIndex.size, 1, "terminal and sourceless rows never enter the obligation index");
assert.deepEqual(openObligationIndex([]), new Map());
const blockedRow = rawEpic("BLOCKED", "done");
const blockedEpic = normalizeEpic(blockedRow, {
  task: { ...blockedRow, epic_children: [{ id: "CH", ref: "HAP-CH", title: "Child", status: "active", open: true }] },
  metadata: { "delivery.state": "committed", "delivery.obligation": "HAP-OB" },
  related: [obligation],
});
assert.deepEqual(blockedEpic.openTasks.map(({ ref }) => ref), ["HAP-OB", "HAP-CH"]);
const childBlockedRow = rawEpic("CHILDROOT", "done", {
  epic_children: [{ id: "CH2", ref: "HAP-CH2", title: "Done child", status: "done", open: false }],
});
const childBlockedEpic = normalizeEpic(childBlockedRow, {
  task: { ...childBlockedRow },
  metadata: { "delivery.state": "committed" },
}, openObligationIndex([
  { task: { ref: "HAP-COB", title: "Manual main check", status: "todo" }, metadata: { "delivery.obligation-for": "HAP-CH2" } },
]));
assert.deepEqual(childBlockedEpic.openTasks, [{ ref: "HAP-COB", title: "Manual main check", status: "todo", kind: "delivery" }],
  "a root card surfaces its terminal child's open delivery obligation");
assert.deepEqual(normalizeEpic(blockedRow).openTasks, [], "unhydrated cards never claim open blockers");

// The bounded pool preserves input order and never exceeds its width.
let activeReads = 0;
let peakReads = 0;
const pooled = await mapLimit([1, 2, 3, 4, 5], 2, async (value) => {
  activeReads += 1;
  peakReads = Math.max(peakReads, activeReads);
  await new Promise((resolve) => setTimeout(resolve, 4 - (value % 3)));
  activeReads -= 1;
  return value * 10;
});
assert.deepEqual(pooled, [10, 20, 30, 40, 50]);
assert.equal(peakReads, 2, "the worker pool is bounded");
assert.deepEqual(await mapLimit([], 4, async () => { throw new Error("must not run"); }), []);

// Progressive startup: a fast detail publishes while a slow read is still
// pending, so the board can draw before enrichment finishes.
let releaseSlow;
const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
const hydrationEvents = [];
const slowRows = [rawEpic("FAST"), rawEpic("SLOW", "done")];
const hydrating = hydrateDetails({
  rows: slowRows,
  workspace: "default",
  cached: () => undefined,
  limit: 2,
  read: async (row) => {
    if (row.id === "SLOW") await slowGate;
    return detail(row, row.id === "SLOW" ? fullApproval : { "sdd.plan-worked-out": "true" });
  },
  publish: (row, snapshot) => hydrationEvents.push([row.id, snapshot]),
});
await new Promise((resolve) => setTimeout(resolve, 10));
assert.deepEqual(hydrationEvents.map(([id]) => id), ["FAST"], "the fast detail publishes before the slow read resolves");
assert.equal(hydrationEvents[0][1].detail.task.id, "FAST");
releaseSlow();
const hydration = await hydrating;
assert.equal(hydration.needed, 2);
assert.deepEqual(hydration.failures, []);
assert.deepEqual(hydrationEvents.map(([id]) => id), ["FAST", "SLOW"]);

// Already-current ordinary details are not re-read; approval-sensitive ones are.
const cachedRows = [rawEpic("CACHE"), rawEpic("APPROVED", "done")];
const hydratedCache = {
  CACHE: { workspace: "default", updatedAt: cachedRows[0].updated_at, detail: detail(cachedRows[0]) },
  APPROVED: { workspace: "default", updatedAt: cachedRows[1].updated_at, detail: detail(cachedRows[1], fullApproval) },
};
const readIds = [];
await hydrateDetails({
  rows: cachedRows,
  workspace: "default",
  cached: (row) => hydratedCache[row.id],
  read: async (row) => { readIds.push(row.id); return detail(row, fullApproval); },
});
assert.deepEqual(readIds, ["APPROVED"], "only the approval-sensitive detail is re-read");

// A failed or mismatched read invalidates the cache and is reported by ref.
const failedEvents = [];
const failures = await hydrateDetails({
  rows: [rawEpic("BAD")],
  workspace: "default",
  cached: () => undefined,
  read: async () => { throw new Error("aven show failed"); },
  publish: (row, snapshot) => failedEvents.push([row.id, snapshot]),
});
assert.deepEqual(failures.failures, ["HAP-BAD: aven show failed"]);
assert.deepEqual(failedEvents, [["BAD", null]]);
const mismatchedHydration = await hydrateDetails({
  rows: [rawEpic("WANTED")],
  workspace: "default",
  cached: () => undefined,
  read: async () => detail(rawEpic("OTHER")),
});
assert.match(mismatchedHydration.failures[0], /identity mismatch/);

// Provisional boards stay fail-closed: an unhydrated or still-enriching Done
// card cannot be archived, while a fully hydrated final board can.
const finalDone = card("done");
const provisionalDone = cardForEpic(normalizeEpic(rawEpic("DONE", "done")), selectAttempt([], "DONE"));
assert.equal(cardArchiveable(finalDone, { enriching: false, evidencePending: false }), true);
assert.equal(cardArchiveable(provisionalDone, { enriching: false, evidencePending: false }), false, "unhydrated cards never archive");
assert.equal(cardArchiveable(finalDone, { enriching: true, evidencePending: false }), false, "enrichment blocks archive");
assert.equal(cardArchiveable(finalDone, { enriching: false, evidencePending: true }), false, "ancestry evidence blocks archive");
assert.equal(cardArchiveable({ ...finalDone, column: "ready" }, {}), false, "only Done cards archive");
assert.equal(enrichmentPending({}), false);

console.log("aven kanban logic ok");
