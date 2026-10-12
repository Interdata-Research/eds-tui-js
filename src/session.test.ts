import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message } from "ollama";
import { repairAfterStop } from "./session.js";

test("repairAfterStop: tool calls stopped before their results get placeholder results, then a stopped note", () => {
  const messages: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "check both" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "run_command", arguments: { command: "a" } } }, { function: { name: "run_command", arguments: { command: "b" } } }] },
    { role: "tool", content: "a's output" },
  ];
  repairAfterStop(messages);
  assert.deepEqual(messages.slice(3).map((m) => [m.role, m.content]), [
    ["tool", "a's output"],
    ["tool", "(not run: stopped by the user)"],
    ["assistant", "(Stopped by the user before finishing.)"],
  ]);
});

test("repairAfterStop: stopped before any reply: the user's message gets the stopped note", () => {
  const messages: Message[] = [{ role: "system", content: "s" }, { role: "user", content: "hi" }];
  repairAfterStop(messages);
  assert.deepEqual(messages[2], { role: "assistant", content: "(Stopped by the user before finishing.)" });
});
