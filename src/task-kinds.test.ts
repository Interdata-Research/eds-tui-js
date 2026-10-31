import { test } from "node:test";
import assert from "node:assert/strict";
import { kindOf } from "./task-kinds.js";

// The same answers as the AI Command Center's tests/test_llm_router.py (app/task_kinds.py): keep them in step.
test("kindOf: the kind with the most of its words, 'other' when none", () => {
  assert.equal(kindOf("commit and push the branch"), "git");
  assert.equal(kindOf("how much disk space is left in /var"), "files");
  assert.equal(kindOf("restart the ollama service"), "services");
  assert.equal(kindOf("hello there"), "other");
  assert.equal(kindOf("list the running docker containers"), "docker");
  assert.equal(kindOf("find the biggest files in /home"), "files");
});
