import assert from "node:assert/strict";
import {
  ATTEMPT_LIMIT, BOARD_COLUMNS, DISPATCH_ACTIONS, LIMIT, MERGE_PROMPT, assertBoardCoverage, buildBoard, cardForEpic, detailArgs,
  dispatchTerminalName, epicArgs, flattenBoard, indexAttempts, isLiveEpicTerminal, markMergedOnMain, mergeArgs, mergeEpicRows,
  mergeRole, mergeTerminal, moveSelection, normalizeAttempt, normalizeEpic, openArgs, selectedCard,
  selectAttempt, terminalName, upcomingArgs,
} from "../app/aven-kanban/logic.js";

const rawEpic = (id, status = "todo", extra = {}) => ({
  id, ref: `HAP-${id}`, title: `Epic ${id}`, project: "herdr-aven-plugin", status,
  is_epic: true, deleted: false, created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z", epic_children: [], ...extra,
});
const detail = (row, metadata = {}, extra = {}) => ({
  task: { ...row, ...extra }, metadata,
});
const attempt = (taskId, extra = {}) => ({
  task_id: taskId, task_ref: `HAP-${taskId}`, workflow: "implementation", attempt_id: `att-${taskId}`,
  generation: 0, created_at: 100, state: "running", execution_mode: "single-session",
  worktree: "/repo/result", branch: "ignored-for-identity", lifecycle: { contradiction: "" },
  terminal: { address: "t-builder", core_id: "core", name: "builder" },
  coordinator_terminal: { address: "t-coordinator", core_id: "core", name: "coordinator" },
  pending_prompt: "must not enter the board model", ...extra,
});
const card = (status = "todo", metadata = {}, attempts = [], extra = {}) => {
  const row = rawEpic("ONE", status, extra);
  const epic = normalizeEpic(row, detail(row, metadata));
  return cardForEpic(epic, selectAttempt(attempts, epic.id));
};

assert.deepEqual(epicArgs("default"), ["list", "--workspace", "default", "--epics", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(upcomingArgs("default"), ["list", "--workspace", "default", "--upcoming", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(detailArgs("default", "HAP-ONE"), ["show", "HAP-ONE", "--workspace", "default", "--full", "--json"]);
assert.deepEqual(DISPATCH_ACTIONS.map(({ detailKey }) => detailKey), ["d", "s", "p", "i", "r", "x", "b"]);
assert.deepEqual(BOARD_COLUMNS.map(({ id }) => id), ["backlog", "planned", "progress", "review", "done"]);
assert.doesNotThrow(() => assertBoardCoverage({ available: LIMIT - 1, upcoming: LIMIT - 1, attempts: ATTEMPT_LIMIT - 1, epics: LIMIT - 1 }));
assert.throws(() => assertBoardCoverage({ available: LIMIT }), /epic read reached/);
assert.throws(() => assertBoardCoverage({ upcoming: LIMIT }), /epic read reached/);
assert.throws(() => assertBoardCoverage({ epics: LIMIT }), /epic read reached/, "merged available/upcoming coverage is capped before metadata hydration");
assert.throws(() => assertBoardCoverage({ attempts: ATTEMPT_LIMIT }), /dispatcher read reached/);

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
  details: { PLANNED: detail(plannedRow, { "sdd.plan-worked-out": "true", "delivery.target": "main" }) },
});
assert.deepEqual(merged.map(({ id }) => id), ["FUTURE", "PLANNED", "OLD"]);
const planned = merged.find(({ id }) => id === "PLANNED");
assert.equal(planned.planWorkedOut, true);
assert.equal(planned.hydrated, true);
assert.equal(planned.deliveryTarget, "main");
assert.equal(normalizeEpic(plannedRow).hydrated, false, "missing detail is unknown, not evidence of an unplanned/delivered task");
const mismatched = normalizeEpic(plannedRow, detail(rawEpic("OTHER"), { "sdd.plan-worked-out": "true" }));
assert.equal(mismatched.hydrated, false, "detail IDs must corroborate list identity");
assert.equal(mismatched.planWorkedOut, false);
const withPhases = rawEpic("PHASES", "active", { epic_children: [
  { id: "A", status: "done", open: false }, { id: "B", status: "active", open: true }, { id: "C", status: "canceled", open: false },
] });
assert.deepEqual(normalizeEpic(withPhases).phases, { complete: 2, total: 3 });

// Every lifecycle column and the independent acceptance/execution/delivery facts.
assert.equal(card("inbox").column, "backlog");
assert.equal(card("backlog").column, "backlog");
assert.equal(card("todo").column, "backlog");
assert.equal(card("todo", { "sdd.plan-worked-out": "true" }).column, "planned");
assert.equal(card("active", { "sdd.plan-worked-out": "true" }).column, "progress");
assert.equal(card("todo", { "sdd.plan-worked-out": "true" }, [attempt("ONE")]).column, "progress", "execution moves a planned card without editing Aven");
assert.equal(card("todo", {}, [attempt("ONE", { state: "failed" })]).column, "progress");
assert.equal(card("todo", {}, [attempt("ONE", { state: "interrupted" })]).column, "progress");
assert.equal(card("active", {}, [attempt("ONE", { state: "needs-review" })]).column, "review");
assert.equal(card("active", {}, [attempt("ONE", { state: "completed" })]).column, "review");
assert.equal(card("done", {}, [attempt("ONE", { state: "needs-review" })]).column, "review");
assert.equal(card("done", { "delivery.state": "pending" }).column, "review");
assert.equal(card("done", { "delivery.state": "committed" }).column, "review");
assert.equal(card("done", { "delivery.state": "merged" }).column, "done");
assert.equal(card("done").column, "done", "legacy accepted work stays Done when no pending delivery fact exists");
assert.equal(card("canceled").column, "done");
const mainMerged = card("done", {}, [attempt("ONE", { state: "needs-review" })], { mergedOnMain: true });
assert.equal(mainMerged.column, "done", "exact local-main ancestry moves terminal work out of Review despite stale execution");
assert.match(mainMerged.warnings.join(" "), /closeout not recorded/, "unrecorded closeout remains visible");
assert.equal(card("done", { "delivery.state": "pending" }, [], { mergedOnMain: true }).column, "done", "main ancestry satisfies pending delivery presentation for terminal work");
assert.equal(card("canceled", {}, [attempt("ONE", { state: "interrupted" })], { mergedOnMain: true }).column, "done");
assert.equal(card("active", { "delivery.state": "pending" }, [], { mergedOnMain: true }).column, "review", "an active epic cannot be closed from code ancestry alone (HAP-SZ57)");
assert.equal(card("done", {}, [attempt("ONE", { state: "needs-review" })]).column, "review", "unmerged terminal work remains Review");
const marked = markMergedOnMain([normalizeEpic(rawEpic("ONE", "done")), normalizeEpic(rawEpic("TWO", "done"))], new Set(["ONE"]));
assert.equal(marked[0].mergedOnMain, true);
assert.equal(marked[1].mergedOnMain, false);
assert.equal(card("done", {}, [attempt("ONE", { state: "running", lifecycle: { contradiction: "terminal_live_execution" } })]).column, "review");
assert.match(card("done", {}, [attempt("ONE", { state: "running", lifecycle: { contradiction: "terminal_live_execution" } })]).warnings.join(" "), /conflicts with active execution/);
const unhydratedRow = rawEpic("UNKNOWN");
assert.match(cardForEpic(normalizeEpic(unhydratedRow), selectAttempt([], unhydratedRow.id)).warnings.join(" "), /Plan metadata/, "unhydrated todo is labeled rather than presented as certainly unplanned");

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
assert.equal(card("active", {}, [attempt("ONE", { attempt_id: "one" }), attempt("ONE", { attempt_id: "two" })]).mergeable, false);
const duplicate = selectAttempt([attempt("ONE"), attempt("ONE")], "ONE");
assert.equal(duplicate.ambiguous, false, "duplicate observations of one attempt do not fabricate ambiguity");
const safeAttempt = normalizeAttempt(attempt("ONE"));
assert.equal("pending_prompt" in safeAttempt, false);
assert.equal("prompt" in safeAttempt, false);

// Merge handoff is restricted to an exact review terminal and role.
const review = card("active", {}, [attempt("ONE", { state: "needs-review" })]);
assert.equal(review.mergeable, true);
assert.equal(review.mergeRole, "builder");
assert.deepEqual(mergeArgs(review, review.attempt), [
  "message", "ONE", "--workflow", "implementation", "--attempt-id", "att-ONE", "--generation", "0",
  "--role", "builder", "--terminal", "t-builder", "--text", `${MERGE_PROMPT} ONE`,
]);
const coordinated = card("active", {}, [attempt("ONE", { state: "needs-review", execution_mode: "worktrees" })]);
assert.equal(coordinated.mergeRole, "coordinator");
assert.equal(mergeTerminal(coordinated.attempt).address, "t-coordinator");
assert.deepEqual(mergeArgs(coordinated, coordinated.attempt).slice(-6), ["--role", "coordinator", "--terminal", "t-coordinator", "--text", `${MERGE_PROMPT} ONE`]);
assert.equal(card("active", {}, [attempt("ONE", { state: "needs-review", execution_mode: "worktrees", coordinator_terminal: { address: "" } })]).mergeable, false, "no builder fallback for coordinator-owned work");
assert.equal(card("done").mergeable, false);
assert.equal(card("active", {}, [attempt("ONE", { state: "running" })]).mergeable, false);
assert.equal(card("done", { "delivery.state": "pending" }, [attempt("ONE", { state: "running" })]).mergeable, false, "active execution cannot be bypassed by pending delivery");
assert.equal(card("done", { "delivery.state": "pending" }, [attempt("ONE", { state: "unrecognized" })]).mergeable, false, "unknown execution fails closed even with pending delivery");
assert.equal(card("active", {}, [attempt("ONE", { state: "needs-review", lifecycle: { contradiction: "terminal_live_execution" } })]).mergeable, false, "contradictory evidence suppresses merge");
assert.throws(() => mergeArgs(review, null), /No unambiguous review terminal/);

const replacementAttempt = attempt("ONE", { attempt_id: "att-replacement", generation: 1, created_at: 999, terminal: { address: "t-replacement" } });
const pinnedArgs = mergeArgs(review, review.attempt);
assert.ok(pinnedArgs.includes("att-ONE") && pinnedArgs.includes("t-builder"), "the click command remains pinned to the rendered attempt");
assert.equal(pinnedArgs.includes(replacementAttempt.attempt_id), false);
assert.equal(pinnedArgs.includes(replacementAttempt.terminal.address), false);

// Board order, per-refresh immutable-ID indexing, keyboard selection, and exact terminal identity.
const attemptIndex = indexAttempts([attempt("B", { state: "needs-review" }), attempt("OTHER")]);
assert.deepEqual([...attemptIndex.keys()].sort(), ["B", "OTHER"]);
assert.equal(attemptIndex.get("B")[0].attemptId, "att-B");
assert.equal("pending_prompt" in attemptIndex.get("B")[0], false);
const boardRows = ["A", "B", "C", "D", "E"].map((id) => rawEpic(id));
const board = buildBoard({ rows: boardRows, attemptIndex });
assert.equal(flattenBoard(board).length, 5);
assert.equal(board.find(({ id }) => id === "review").cards[0].id, "B");
const ordered = flattenBoard(board).map(({ id }) => id);
const first = moveSelection(board, "", 1);
assert.equal(first, ordered[0]);
assert.equal(moveSelection(board, first, 1), ordered[1]);
assert.equal(moveSelection(board, ordered.at(-1), 1), ordered[0], "next wraps");
assert.equal(moveSelection(board, ordered[0], -1), ordered.at(-1), "previous wraps");
assert.equal(moveSelection([], "", 1), "");
assert.equal(selectedCard(board, "B").column, "review");
assert.equal(selectedCard(board, "missing"), null);

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
assert.equal(mergeRole(null), "builder");

console.log("aven kanban logic ok");
