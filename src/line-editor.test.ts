import { test } from "node:test";
import assert from "node:assert/strict";
import { LineEditor } from "./line-editor.js";

const types = (events: { type: string }[]) => events.map((e) => e.type);

test("LineEditor: typing and Enter submit the line and clear it; Enter on an empty line is an empty submit", () => {
  const ed = new LineEditor();
  assert.deepEqual(types(ed.feed("hello")), ["changed"]);
  const ev = ed.feed("\r");
  assert.deepEqual(ev[0], { type: "submit", text: "hello" });
  assert.equal(ed.buf, "");
  assert.deepEqual(ed.feed("\r")[0], { type: "submit", text: "" });
});

test("LineEditor: a lone Esc waits for flushEscape (it also starts arrow keys); arrows still edit", () => {
  const ed = new LineEditor();
  ed.feed("abc");
  assert.deepEqual(types(ed.feed("\x1b")), []);
  assert.deepEqual(ed.flushEscape(), [{ type: "escape" }]);
  ed.feed("\x1b[D\x1b[DX");
  assert.equal(ed.buf, "aXbc");
  // An arrow split across two reads is still an arrow, not an Esc.
  ed.feed("\x1b");
  ed.feed("[C");
  assert.deepEqual(ed.flushEscape(), []);
  assert.equal(ed.cursor, 3);
});

test("LineEditor: Ctrl-C, Ctrl-D only on an empty line, ↑ only on an empty line", () => {
  const ed = new LineEditor();
  assert.deepEqual(types(ed.feed("\x03")), ["interrupt"]);
  assert.deepEqual(types(ed.feed("\x04")), ["eof"]);
  assert.deepEqual(types(ed.feed("\x1b[A")), ["up", "changed"]);
  ed.feed("x");
  assert.deepEqual(types(ed.feed("\x04")), []);
  assert.deepEqual(types(ed.feed("\x1b[A")), ["changed"], "↑ with text in the line just doesn't pull anything back");
});

test("LineEditor: a multi-line paste collapses and is spliced back on submit", () => {
  const ed = new LineEditor();
  ed.feed("fix \x1b[200~line one\nline two\x1b[201~ please");
  assert.equal(ed.buf, "fix [+2 lines] please");
  assert.deepEqual(ed.feed("\r")[0], { type: "submit", text: "fix line one\nline two please" });
});
