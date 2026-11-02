import assert from "node:assert/strict";
import {
  LIMIT, canonicalId, isLiveEpicTerminal, launchArgs, mergeCoverage,
  mergeProjectRows, openArgs, projectArgs, resolveSpaceContext, sortEpics, terminalName, upcomingArgs,
} from "../app/aven-panel/logic.js";

const epic = (id, created_at, extra = {}) => ({ id, ref: `HAP-${id}`, title: id, status: "todo", is_epic: true, created_at, ...extra });
assert.deepEqual(projectArgs("default"), ["project", "list", "--workspace", "default", "--limit", String(LIMIT), "--json"]);
assert.deepEqual(openArgs("default", "HAP").slice(0, 7), ["list", "--workspace", "default", "--project", "HAP", "--open", "--epics"]);
assert.equal(upcomingArgs("default", "HAP").includes("--epics"), false, "upcoming is filtered locally");
const rows = mergeProjectRows({ workspace: "default", project: "HAP", open: [epic("old", "2026-01-01T00:00:00Z"), epic("same", "2026-02-01T00:00:00Z"), { ...epic("gone", "2026-03-01T00:00:00Z"), deleted: true }, { ...epic("task", "2026-03-01T00:00:00Z"), is_epic: false }], upcoming: [epic("new", "2026-03-01T00:00:00Z"), epic("same", "2026-04-01T00:00:00Z"), epic("done", "2026-04-01T00:00:00Z", { status: "done" })] });
assert.deepEqual(rows.map((row) => row.id), ["new", "same", "old"], "deferred epics merge and canonical ids dedupe");
assert.deepEqual(sortEpics([epic("b", "bad"), epic("a", "bad"), epic("c", "2026-01-01T00:00:00Z")]).map((row) => row.id), ["c", "a", "b"], "created order, ties and invalid dates are deterministic");
assert.equal(canonicalId({ canonical_id: "canonical" }), "canonical");
const merged = mergeCoverage([{ project: "HAP", rows }, { project: "OTHER", error: "timeout" }]);
assert.equal(merged.rows.length, 3); assert.match(merged.coverageError, /OTHER: timeout/);
const target = { id: "epic/id", ref: "HAP-EPIC" }, name = `${terminalName("default", target.id)}test`;
assert.equal(isLiveEpicTerminal({ state: "live", name }, "default", target.id), true);
assert.equal(isLiveEpicTerminal({ state: "dead", name }, "default", target.id), false);
assert.deepEqual(launchArgs({ workspace: "default", epic: target, cwd: "/repo", name }).slice(-5), ["--", "aven", "--workspace", "default", "tui", "HAP-EPIC"].slice(-5));
assert.equal(launchArgs({ workspace: "default", epic: target, cwd: "", name }).includes("--cwd"), false);
const root = { id: "root", ref: "HAP-ROOT", is_epic: true, title: "Root" };
const context = resolveSpaceContext({ space: { name: "review", folder: "/repo" }, attempts: [{ worktree: "/repo" }], task: { ref: "HAP-CHILD" }, root, rows: [root] });
assert.equal(context.kind, "dispatch"); assert.equal(context.pinned.id, "root");
assert.equal(resolveSpaceContext({ space: { folder: "/none" }, attempts: [] }).kind, "unavailable");
assert.equal(resolveSpaceContext({ space: { folder: "/repo" }, attempts: [{ worktree: "/repo" }], task: { ref: "HAP" }, root: { ref: "HAP" } }).kind, "stale");
console.log("aven panel logic ok");
