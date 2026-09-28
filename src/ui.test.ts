import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { displayModel, deindentOverIndentedLists } from "./ui.js";

test("displayModel: strips a trailing :cloud tag", () => {
  assert.equal(displayModel("deepseek-v4-pro:cloud"), "deepseek-v4-pro");
  assert.equal(displayModel("kimi-k3:cloud"), "kimi-k3");
});

test("displayModel: leaves other tags (and untagged names) alone", () => {
  assert.equal(displayModel("qwen3.8:latest"), "qwen3.8:latest");
  assert.equal(displayModel("qwen3-coder:30b"), "qwen3-coder:30b");
  assert.equal(displayModel("tiny:1b"), "tiny:1b");
  assert.equal(displayModel("some-model-with-no-tag"), "some-model-with-no-tag");
});

test("displayModel: only strips :cloud at the very end, not a look-alike substring earlier in the name", () => {
  assert.equal(displayModel("cloudy-model:8b"), "cloudy-model:8b");
});

// ---------- deindentOverIndentedLists ----------
//
// CommonMark treats 4+ leading spaces as an indented CODE block, not a
// list, so a model that indents bullets under a heading silently breaks
// rendering — the whole block becomes literal, unparsed text. These tests
// verify both the string transformation AND the actual downstream lexer
// outcome (list vs. code), since the transformation only matters insofar as
// it changes how marked actually tokenizes the result.

test("deindentOverIndentedLists: a 4-space-indented bullet block, alone, is otherwise lexed as CODE not a list", () => {
  const indented = "    * one\n    * two\n";
  assert.equal(marked.lexer(indented)[0]!.type, "code", "sanity check: this is the exact bug being fixed");
});

test("deindentOverIndentedLists: shifts an over-indented list left so it lexes as a real list", () => {
  const indented = "## Heading\n\n    * one\n    * two\n";
  const fixed = deindentOverIndentedLists(indented);
  assert.equal(fixed, "## Heading\n\n* one\n* two\n");
  const tokens = marked.lexer(fixed);
  assert.ok(tokens.some((t) => t.type === "list"), "must actually lex as a list after fixing");
  assert.ok(!tokens.some((t) => t.type === "code"), "must not still lex as a code block");
});

test("deindentOverIndentedLists: preserves relative nesting between sub-bullets, not just flattening everything to 0", () => {
  const indented = "    * top\n        * nested\n";
  const fixed = deindentOverIndentedLists(indented);
  assert.equal(fixed, "* top\n    * nested\n");
});

test("deindentOverIndentedLists: leaves an already-correctly-indented list (< 4 spaces) untouched", () => {
  const ok = "* top\n  * nested\n";
  assert.equal(deindentOverIndentedLists(ok), ok);
});

test("deindentOverIndentedLists: never touches content inside a fenced code block, even if it looks like a list", () => {
  const fenced = "```bash\n    * this is a shell comment, not a list item\n```\n";
  assert.equal(deindentOverIndentedLists(fenced), fenced);
});

test("deindentOverIndentedLists: leaves ordinary prose and headings completely alone", () => {
  const prose = "Just a paragraph.\n\n## A heading\n\nAnother paragraph.\n";
  assert.equal(deindentOverIndentedLists(prose), prose);
});

test("deindentOverIndentedLists: handles multiple separate over-indented list blocks in one document independently", () => {
  const doc = "## A\n\n    * a1\n    * a2\n\n## B\n\n    * b1\n";
  assert.equal(deindentOverIndentedLists(doc), "## A\n\n* a1\n* a2\n\n## B\n\n* b1\n");
});
