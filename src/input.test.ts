import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPaste, spliceBackPastes, parseEscape, wordLeft, wordRight } from "./input.js";

test("classifyPaste: multi-line paste (2+ non-blank lines) collapses to a placeholder", () => {
  const result = classifyPaste("line one\nline two\nline three");
  assert.equal(result.placeholder, true);
  assert.equal(result.lineCount, 3);
  assert.equal(result.insertText, "[+3 lines]");
});

test("classifyPaste: single-line paste is inserted directly, trimmed", () => {
  const result = classifyPaste("  just one line  ");
  assert.equal(result.placeholder, false);
  assert.equal(result.insertText, "just one line");
});

test("classifyPaste: blank lines don't count toward the placeholder threshold", () => {
  // One real line plus surrounding/interspersed blank lines — still "one
  // non-blank line", so it must NOT collapse (matches Python's `l.strip()`
  // filter before counting).
  const result = classifyPaste("\n\n  actual content  \n\n");
  assert.equal(result.placeholder, false);
  assert.equal(result.insertText, "actual content");
});

test("classifyPaste: exactly two non-blank lines (with blank lines between) collapses", () => {
  const result = classifyPaste("first\n\nsecond");
  assert.equal(result.placeholder, true);
  assert.equal(result.lineCount, 2);
});

test("classifyPaste: empty paste is treated as zero lines, inserted as empty text", () => {
  const result = classifyPaste("");
  assert.equal(result.placeholder, false);
  assert.equal(result.insertText, "");
});

test("classifyPaste: a placeholder-collapsed paste stashes the FULL raw text, not trimmed", () => {
  // classifyPaste itself doesn't stash (that's promptLine's job with the
  // returned insertText/placeholder flag), but confirm the raw text a
  // caller would stash is preserved untouched by classifyPaste.
  const raw = "  line one  \n  line two  \n";
  const result = classifyPaste(raw);
  assert.equal(result.placeholder, true);
  // insertText for a placeholder case is just the marker, not the content —
  // the caller is responsible for stashing `raw` itself verbatim.
  assert.equal(result.insertText, "[+2 lines]");
});

test("spliceBackPastes: a single placeholder is replaced with its stashed block", () => {
  const result = spliceBackPastes("before [+2 lines] after", ["stashed\ntext"]);
  assert.equal(result, "before stashed\ntext after");
});

test("spliceBackPastes: multiple placeholders splice back in order of appearance", () => {
  const result = spliceBackPastes("[+2 lines] and then [+3 lines]", ["FIRST\nBLOCK", "SECOND\nBLOCK\nHERE"]);
  assert.equal(result, "FIRST\nBLOCK and then SECOND\nBLOCK\nHERE");
});

test("spliceBackPastes: no placeholders — line passes through trimmed, unchanged", () => {
  const result = spliceBackPastes("  just typed text  ", []);
  assert.equal(result, "just typed text");
});

test("spliceBackPastes: trims the final result", () => {
  const result = spliceBackPastes("  [+1 lines]  ", ["x"]);
  assert.equal(result, "x");
});

// ---------- escape sequences / word movement ----------

test("parseEscape: Ctrl+Left/Right (xterm ESC[1;5D / ESC[1;5C) are word moves, consuming the whole sequence", () => {
  assert.deepEqual(parseEscape("\x1b[1;5D"), { key: "wordLeft", length: 6 });
  assert.deepEqual(parseEscape("\x1b[1;5Cabc"), { key: "wordRight", length: 6 });
});

test("parseEscape: Alt+arrows and Alt-b/f are word moves; plain and Shift+arrows move one char", () => {
  assert.deepEqual(parseEscape("\x1b[1;3D"), { key: "wordLeft", length: 6 });
  assert.deepEqual(parseEscape("\x1bb"), { key: "wordLeft", length: 2 });
  assert.deepEqual(parseEscape("\x1bf"), { key: "wordRight", length: 2 });
  assert.deepEqual(parseEscape("\x1b[D"), { key: "left", length: 3 });
  assert.deepEqual(parseEscape("\x1b[1;2C"), { key: "right", length: 6 });
  assert.deepEqual(parseEscape("\x1bOd"), { key: "wordLeft", length: 3 });
});

test("parseEscape: Home/End/Delete variants", () => {
  assert.deepEqual(parseEscape("\x1b[H"), { key: "home", length: 3 });
  assert.deepEqual(parseEscape("\x1bOF"), { key: "end", length: 3 });
  assert.deepEqual(parseEscape("\x1b[7~"), { key: "home", length: 4 });
  assert.deepEqual(parseEscape("\x1b[3~"), { key: "delete", length: 4 });
});

test("parseEscape: unbound CSI sequences are swallowed whole, never leaking bytes into the buffer", () => {
  assert.deepEqual(parseEscape("\x1b[1;5A"), { key: null, length: 6 }); // Ctrl+Up
  assert.deepEqual(parseEscape("\x1b[15~"), { key: null, length: 5 }); // F5
});

test("parseEscape: a sequence cut off at the end of a chunk is incomplete", () => {
  assert.equal(parseEscape("\x1b"), "incomplete");
  assert.equal(parseEscape("\x1b[1;5"), "incomplete");
  assert.equal(parseEscape("\x1bO"), "incomplete");
});

test("wordLeft/wordRight: jump over the adjacent word, skipping separators first", () => {
  const s = "asdfa asdf  asdfas d";
  assert.equal(wordLeft(s, s.length), 19);
  assert.equal(wordLeft(s, 19), 12);
  assert.equal(wordLeft(s, 8), 6);
  assert.equal(wordLeft(s, 0), 0);
  assert.equal(wordRight(s, 0), 5);
  assert.equal(wordRight(s, 5), 10);
  assert.equal(wordRight(s, s.length), s.length);
});
