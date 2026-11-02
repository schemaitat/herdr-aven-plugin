import assert from "node:assert/strict";
import { PANEL_CHOICES, STORAGE_KEY, decodeChoices, desiredChoice, encodeChoices, panelCommands, validChoice } from "../app/aven-panel-tabs/logic.js";

assert.deepEqual(PANEL_CHOICES, ["files", "changes", "aven"]);
assert.equal(STORAGE_KEY, "herdr-aven-plugin.aven-panel-tabs.v1");
assert.equal(validChoice("aven"), "aven"); assert.equal(validChoice("unknown"), null);
assert.deepEqual(decodeChoices("not json"), {});
assert.deepEqual(decodeChoices('{"one":"aven","two":"unknown"}'), { one: "aven", two: null });
assert.equal(desiredChoice({ one: "aven" }, "one"), "aven");
assert.equal(encodeChoices({ one: "aven", two: null }), '{"one":"aven"}');
assert.deepEqual(panelCommands("aven", true, "aven"), [{ name: "layout.hide", args: { id: "panel" } }]);
assert.deepEqual(panelCommands("aven", false, "files"), [{ name: "layout.select", args: { stack: "panel-body", child: "aven" } }, { name: "layout.show", args: { id: "panel" } }]);
console.log("aven panel tabs logic ok");
