import assert from "node:assert/strict";
import {
  DISPATCH_ACTIONS, LIMIT, canonicalId, dispatchLabel, dispatchTargets, focusedPhase, inferredEpicArgs, inferredUpcomingArgs,
  isLiveEpicTerminal, launchArgs, lifecycleStage, mergeCoverage, mergeProjectRows, openArgs, phaseProgress, projectArgs,
  resolveSpaceContext, scopeEpics, sortEpics, statusLabel, terminalName, upcomingArgs,
} from "../app/aven-panel/logic.js";

const epic = (id, created_at, extra = {}) => ({ id, ref: `HAP-${id}`, title: id, status: "todo", is_epic: true, created_at, ...extra });
assert.deepEqual(projectArgs("default"), ["project", "list", "--workspace", "default", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(inferredEpicArgs("default"), ["list", "--workspace", "default", "--epics", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(inferredUpcomingArgs("default"), ["list", "--workspace", "default", "--upcoming", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(DISPATCH_ACTIONS.map(({ label }) => label), ["z d", "z s", "z p", "z i", "z r", "z x", "z b"]);
assert.deepEqual(DISPATCH_ACTIONS.map(({ detailKey }) => detailKey), ["d", "s", "p", "i", "r", "x", "b"], "buttons send lowercase task-detail bindings through hc");
assert.ok(DISPATCH_ACTIONS.every(({ description }) => description.length > 0), "each dispatcher shortcut has a menu description");
assert.deepEqual(openArgs("default", "HAP").slice(0, 7), ["list", "--workspace", "default", "--project", "HAP", "--open", "--epics"]);
assert.equal(upcomingArgs("default", "HAP").includes("--epics"), false, "upcoming is filtered locally");
const rows = mergeProjectRows({ workspace: "default", project: "HAP", open: [epic("old", "2026-01-01T00:00:00Z"), epic("canceled", "2026-01-15T00:00:00Z", { status: "canceled" }), epic("same", "2026-02-01T00:00:00Z"), { ...epic("gone", "2026-03-01T00:00:00Z"), deleted: true }, { ...epic("task", "2026-03-01T00:00:00Z"), is_epic: false }], upcoming: [epic("new", "2026-03-01T00:00:00Z"), epic("same", "2026-04-01T00:00:00Z"), epic("done", "2026-04-01T00:00:00Z", { status: "done" })] });
assert.deepEqual(rows.map((row) => row.id), ["new", "same", "old"], "done and canceled epics are hidden while other statuses and deduplication are preserved");
assert.deepEqual(sortEpics([epic("b", "bad"), epic("a", "bad"), epic("c", "2026-01-01T00:00:00Z")]).map((row) => row.id), ["c", "a", "b"], "created order, ties and invalid dates are deterministic");
assert.equal(canonicalId({ canonical_id: "canonical" }), "canonical");
const merged = mergeCoverage([{ project: "HAP", rows }, { project: "OTHER", error: "timeout" }]);
assert.equal(merged.rows.length, 3); assert.match(merged.coverageError, /OTHER: timeout/);
const target = { id: "epic/id", ref: "HAP-EPIC" }, name = `${terminalName("default", target.id)}test`;
assert.ok(name.length <= 32, "terminal names fit herdr-core's 32-character limit");
assert.notEqual(terminalName("default", target.id), terminalName("other", target.id), "terminal names are workspace-specific");
assert.equal(isLiveEpicTerminal({ state: "live", name }, "default", target.id), true);
assert.equal(isLiveEpicTerminal({ state: "dead", name }, "default", target.id), false);
assert.deepEqual(launchArgs({ workspace: "default", epic: target, cwd: "/repo", name }).slice(-5), ["--", "aven", "--workspace", "default", "tui", "HAP-EPIC"].slice(-5));
assert.equal(launchArgs({ workspace: "default", epic: target, cwd: "", name }).includes("--cwd"), false);
const root = { id: "root", ref: "HAP-ROOT", is_epic: true, title: "Root" };
const context = resolveSpaceContext({ space: { name: "review", folder: "/repo" }, attempts: [{ worktree: "/repo" }], task: { ref: "HAP-CHILD" }, root, rows: [root] });
assert.equal(context.kind, "dispatch"); assert.equal(context.pinned.id, "root");
assert.deepEqual(scopeEpics([root, { ...root, id: "other", ref: "HAP-OTHER" }], "space", context).map((row) => row.id), ["root"], "space scope shows only the root epic identified from its worktree task");
assert.deepEqual(scopeEpics([root], "space", { kind: "unavailable" }), [root], "a non-dispatched root space shows the epics already scoped to its project");
assert.equal(scopeEpics([root], "all", { kind: "unavailable" }).length, 1, "all scope keeps the full workspace result");
assert.equal(resolveSpaceContext({ space: { folder: "/none" }, attempts: [] }).kind, "unavailable");
assert.equal(resolveSpaceContext({ space: { folder: "/repo" }, attempts: [{ worktree: "/repo" }], task: { ref: "HAP" }, root: { ref: "HAP" } }).kind, "stale");

const phases = [
  { id: "p1", ref: "HAP-P1", title: "first", status: "done", open: false },
  { id: "p2", ref: "HAP-P2", title: "second", status: "active", open: true },
];
const rootWithPhases = { ...root, epic_children: phases };
assert.deepEqual(phaseProgress(phases), { complete: 1, total: 2 }, "phase progress counts terminal children");
const phaseTarget = dispatchTargets([{ task_ref: root.ref, worktree: "/root/", phases: [{ task_ref: "HAP-P1", worktree: "/phase/" }] }], "/phase");
assert.equal(phaseTarget.length, 1, "a phase worktree resolves through its attempt");
assert.equal(phaseTarget[0].taskRef, "HAP-P1");
assert.equal(phaseTarget[0].phase.worktree, "/phase/");
const rootTarget = dispatchTargets([{ task_ref: root.ref, worktree: "/root/" }], "/root");
assert.equal(rootTarget[0].taskRef, root.ref, "the root worktree resolves to the attempt task");
assert.deepEqual(dispatchTargets([{ worktree: "/other" }], "/root"), [], "an unrelated worktree does not resolve");
assert.equal(focusedPhase(rootWithPhases, { ref: "HAP-P2" }).position, 2, "a phase worktree reports its position");
assert.equal(focusedPhase(rootWithPhases, { ref: root.ref }).phase.ref, "HAP-P2", "a root worktree focuses the active phase");
assert.equal(lifecycleStage({ status: "todo", attempt: { state: "needs-review" } }), "Review", "review execution overrides open acceptance");
assert.equal(lifecycleStage({ status: "active", attempt: { state: "running" } }), "In progress");
assert.equal(lifecycleStage({ status: "todo" }), "Planned");
assert.equal(lifecycleStage({ status: "backlog" }), "Backlog");
assert.equal(lifecycleStage({ status: "done" }), "Done");
assert.equal(statusLabel("active"), "Active");
assert.equal(dispatchLabel("prompt-pending"), "Admitting prompt");
assert.equal(dispatchLabel(""), "Not dispatched");
const dispatchContext = resolveSpaceContext({ space: { name: "phase", folder: "/phase/" }, attempts: [], task: { ref: "HAP-P1" }, root: rootWithPhases, rows: [rootWithPhases], target: phaseTarget[0] });
assert.equal(dispatchContext.kind, "dispatch");
assert.equal(dispatchContext.taskRef, "HAP-P1");
assert.equal(dispatchContext.attempt.task_ref, root.ref);
console.log("aven panel logic ok");
