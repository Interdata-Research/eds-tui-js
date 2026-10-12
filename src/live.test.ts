import { test } from "node:test";
import assert from "node:assert/strict";
import { fit, layout } from "./live.js";

const base = { promptText: " proj ❯ ", buf: "", cursor: 0, status: null, queued: [], note: null, cols: 40 };

test("layout: idle is just the input line; busy adds the status and the queued messages", () => {
  assert.deepEqual(layout(base).lines, []);
  const l = layout({ ...base, status: "⠋ Thinking", queued: ["a", "b", "c", "d", "e"] });
  assert.equal(l.lines.length, 1 + 3 + 1, "status, three queued, and '…and 2 more'");
  assert.match(l.lines[4]!, /and 2 more/);
  assert.equal(l.inputRow, 5);
});

test("layout: the cursor's row and column follow a line that wraps", () => {
  const l = layout({ ...base, buf: "x".repeat(50), cursor: 50 });
  // prompt is 8 columns wide: 58 columns -> rows 0 and 1, cursor at column 18 of row 1
  assert.deepEqual([l.cursorRow, l.endRow, l.col], [1, 1, 18]);
  const exact = layout({ ...base, buf: "x".repeat(32), cursor: 32 });
  assert.deepEqual([exact.cursorRow, exact.endRow, exact.col], [1, 0, 0], "a full row: the cursor goes to the next one");
});

test("fit: cuts to the width with an ellipsis, on one line", () => {
  assert.equal(fit("short", 10), "short");
  assert.equal(fit("a much longer\nline of text", 10), "a much lo…");
});
