import assert from "node:assert/strict";
import { PANEL_CHOICES, STORAGE_KEY, decodeChoices, desiredChoice, dispatchFolders, encodeChoices, normalizeFolder, panelCommands, validChoice } from "../app/aven-panel-tabs/logic.js";

assert.deepEqual(PANEL_CHOICES, ["files", "changes", "aven"]);
assert.equal(STORAGE_KEY, "herdr-aven-plugin.aven-panel-tabs.v1");
assert.equal(validChoice("aven"), "aven"); assert.equal(validChoice("unknown"), null);
assert.deepEqual(decodeChoices("not json"), {});
assert.deepEqual(decodeChoices('{"one":"aven","two":"unknown"}'), { one: "aven", two: null });
assert.equal(desiredChoice({ one: "aven" }, "one"), "aven");
assert.equal(desiredChoice({}, "one"), null, "a first visit without dispatch stays hidden");
assert.equal(desiredChoice({}, "one", true), "aven", "a dispatched worktree opens Aven on its first visit");
assert.equal(desiredChoice({ one: "files" }, "one", true), "files", "an explicit panel choice wins over dispatch");
assert.deepEqual([...dispatchFolders([{ worktree: "/root/" }, { worktree: "", phases: [{ worktree: "/phase" }] }])].sort(), ["/phase", "/root"]);
assert.equal(normalizeFolder("/root///"), "/root");
assert.equal(encodeChoices({ one: "aven", two: null }), '{"one":"aven"}');
assert.deepEqual(panelCommands("aven", true, "aven"), [{ name: "layout.hide", args: { id: "panel" } }]);
assert.deepEqual(panelCommands("aven", false, "files"), [{ name: "layout.select", args: { stack: "panel-body", child: "aven" } }, { name: "layout.show", args: { id: "panel" } }]);
console.log("aven panel tabs logic ok");
