import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ATTEMPT_LIMIT, BOARD_COLUMNS, CREATED_FILTERS, DISPATCH_ACTIONS, LIMIT, MERGE_PROMPT, SUMMARY_CARD_LIMIT, SUMMARY_LABEL,
  approvalMarker, archiveKey, assertBoardCoverage, attemptNeedsYou, blockedAddress, boardStats, buildBoard, cardForEpic,
  cardSummary, createdCutoff, detailArgs, detailCacheKey, detailIsCurrent, detailNeedsRefresh, dispatchTerminalName, epicArgs,
  filterArchived, filterRowsByCreated, flattenBoard, indexAttempts, isLiveEpicTerminal, landedWeek, lastQuestion,
  liveAgentFor, markMergedOnMain, mergeAgentRun, mergeApprovalIssue, mergeEpicRows, mergePrompt, mergeTabArgs,
  mergeTabName, moveSelection, nextMove, normalizeAttempt, normalizeEpic, openArgs, projectChips, selectAttempt,
  selectedCard, selectMainSpace, shipPrompt, shipTabName, summaryDigest, summaryNeeded, taskSummary, terminalName,
  upcomingArgs,
} from "../app/aven-kanban/logic.js";

const manifest = JSON.parse(readFileSync(new URL("../app/aven-kanban/mod.json", import.meta.url), "utf8"));
assert.deepEqual(manifest.overlay, { width: 1600, height: 680 });

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

assert.deepEqual(epicArgs("default"), ["list", "--workspace", "default", "--epics", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(upcomingArgs("default"), ["list", "--workspace", "default", "--upcoming", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(detailArgs("default", "HAP-ONE"), ["show", "HAP-ONE", "--workspace", "default", "--full", "--json"]);
assert.deepEqual(DISPATCH_ACTIONS.map(({ detailKey }) => detailKey), ["d", "s", "p", "i", "r", "x", "b"]);
assert.deepEqual(BOARD_COLUMNS.map(({ id }) => id), ["backlog", "needs_you", "working", "ready", "done"]);
assert.deepEqual(BOARD_COLUMNS.map(({ title }) => title), ["BACKLOG", "NEEDS YOU", "WORKING", "READY TO LAND", "DONE"]);
assert.deepEqual(BOARD_COLUMNS.map(({ tone }) => tone), ["dim", "attention", "working", "land", "done"]);
assert.deepEqual(CREATED_FILTERS.map(({ id }) => id), ["all", "1w", "2w", "1mo", "1y"]);
assert.deepEqual(CREATED_FILTERS.map(({ days }) => days), [null, 7, 14, 30, 365]);
assert.doesNotThrow(() => assertBoardCoverage({ available: LIMIT - 1, upcoming: LIMIT - 1, attempts: ATTEMPT_LIMIT - 1, epics: LIMIT - 1 }));
assert.throws(() => assertBoardCoverage({ available: LIMIT }), /epic read reached/);
assert.throws(() => assertBoardCoverage({ upcoming: LIMIT }), /epic read reached/);
assert.throws(() => assertBoardCoverage({ epics: LIMIT }), /epic read reached/, "merged available/upcoming coverage is capped before metadata hydration");
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
const summaryCard = cardForEpic(summarized, selectAttempt([], "SUM"));
assert.equal(summaryCard.summaryCard, "First point. · Second point. · Third point.");
assert.equal(summaryCard.column, "backlog");
assert.equal(
  detailNeedsRefresh({ workspace: "default", updatedAt: "t1", detail: { task: { status: "active" }, metadata: { "summary.llm": "x" } } }, "default", { updated_at: "t1" }),
  true,
  "summary metadata is re-read even when the second-granular timestamp matches",
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
const liveDone = card("done", {}, [attempt("ONE", { state: "terminal-pending", terminals: liveTerminals })], { mergedOnMain: true });
assert.equal(liveDone.agentActive, false, "terminal epics are inert for the working pulse");
assert.match(liveDone.warnings.join(" "), /conflicts with active execution/,
  "genuine activity on terminal work stays a visible contradiction");
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

// Merge is a task-id prompt launched in the main checkout, never a message to a
// builder/coordinator pane.
const approvedEpic = normalizeEpic(rawEpic("ONE", "done"), detail(rawEpic("ONE", "done"), fullApproval));
assert.equal(mergePrompt(approvedEpic), `${MERGE_PROMPT} ONE`);
assert.equal(mergeTabName(approvedEpic), "merge HAP-ONE");
// Herdr appends the task as a positional argument. OpenCode takes a starting
// prompt through --prompt; a bare positional is a project directory.
assert.deepEqual(mergeAgentRun(["opencode"]), ["opencode", "--prompt"]);
assert.deepEqual(mergeAgentRun(["/opt/opencode/bin/opencode"]), ["/opt/opencode/bin/opencode", "--prompt"]);
assert.deepEqual(mergeAgentRun(["opencode", "--prompt"]), ["opencode", "--prompt"]);
assert.deepEqual(mergeAgentRun(["claude"]), ["claude"], "non-OpenCode agents keep positional prompts");
assert.deepEqual(mergeAgentRun(["opencode", "--model", "x"]), ["opencode", "--model", "x", "--prompt"]);
assert.deepEqual(mergeTabArgs({
  name: "merge HAP-ONE", space: "sp-main", folder: "/repo", argv: ["opencode"], task: `${MERGE_PROMPT} ONE`,
}), [
  "do", "tab.new", "--name", "merge HAP-ONE", "--space", "sp-main", "--folder", "/repo",
  "--argv", '["opencode","--prompt"]', "--task", `${MERGE_PROMPT} ONE`,
]);
assert.deepEqual(mergeTabArgs({
  name: "merge HAP-ONE", space: "sp-main", folder: "/repo", argv: ["claude"], task: `${MERGE_PROMPT} ONE`,
})[9], '["claude"]', "merge args leave a positional-prompt agent unchanged");
assert.throws(() => mergeTabArgs({ name: "", space: "sp-main", folder: "/repo", argv: ["opencode"], task: "x" }), /needs a name/);
assert.throws(() => mergeTabArgs({ name: "n", space: "", folder: "/repo", argv: ["opencode"], task: "x" }), /needs a name/);
assert.throws(() => mergePrompt({}), /No approved task identity/);
assert.throws(() => mergeTabName({ id: "ONE" }), /No approved task reference/);

// The main space is the visible space for the primary checkout; the active
// space is only a fallback so a merge tab can still run in the right folder.
const knownSpaces = [
  { id: "worktree", folder: "/repo/worktree", name: "task space" },
  { id: "main", folder: "/repo/", name: "repo" },
  { id: "main2", folder: "/repo", name: "other" },
];
assert.equal(selectMainSpace(knownSpaces, "/repo", "worktree").id, "main", "prefers the space named for the repository");
assert.equal(selectMainSpace(knownSpaces, "/repo", "main2").id, "main2", "prefers the active matching space");
assert.equal(selectMainSpace(knownSpaces, "/repo", "missing").id, "main");
assert.equal(selectMainSpace([{ id: "worktree", folder: "/repo/worktree", name: "task space" }], "/repo", "worktree").id, "worktree", "falls back to the active space");
assert.equal(selectMainSpace([], "/repo", "worktree"), null);

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
assert.equal(moveSelection(board, first, 1), ordered[1]);
assert.equal(moveSelection(board, ordered.at(-1), 1), ordered[0], "next wraps");
assert.equal(moveSelection(board, ordered[0], -1), ordered.at(-1), "previous wraps");
assert.equal(moveSelection([], "", 1), "");
assert.equal(selectedCard(board, "B").column, "ready");
assert.equal(selectedCard(board, "missing"), null);
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

// Ship PR is a separate, explicit agent handoff, never a Git mutation.
assert.match(shipPrompt({ id: "ONE" }), /Aven task ONE/);
assert.match(shipPrompt({ id: "ONE" }), /pull request/);
assert.doesNotMatch(shipPrompt({ id: "ONE" }), /\/ha-merge/);
assert.equal(shipTabName({ ref: "HAP-ONE" }), "ship HAP-ONE");
assert.throws(() => shipPrompt({}), /No approved task identity/);
assert.throws(() => shipTabName({ id: "ONE" }), /No approved task reference/);
assert.equal(mergeTabArgs({
  name: shipTabName({ ref: "HAP-ONE" }), space: "sp-main", folder: "/repo",
  argv: ["opencode"], task: shipPrompt({ id: "ONE" }),
})[0], "do");

console.log("aven kanban logic ok");
