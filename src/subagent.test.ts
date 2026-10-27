import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ollama, Message } from "ollama";
import { makeDelegateTask, SUBAGENT_MAX_TURNS } from "./subagent.js";
import { twoColorPng } from "./vision.js";

const SMALL = "small-model";
const CWD = tmpdir();
const APP_DIR = "/fake/app/dir";

function toolCallResponse(command: string) {
  return {
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "run_command", arguments: { command } } }],
    } as Message,
  };
}
function finalResponse(content: string) {
  return { message: { role: "assistant", content } as Message };
}

test("no tool calls: returns the trimmed content directly", async () => {
  const client = { chat: async () => finalResponse("  the sub-answer  ") } as unknown as Ollama;
  const delegate = makeDelegateTask(SMALL, CWD, APP_DIR);
  const result = await delegate(client, "do a thing");
  assert.equal(result, "the sub-answer");
});

test("empty content becomes '(no result)'", async () => {
  const client = { chat: async () => finalResponse("   ") } as unknown as Ollama;
  const delegate = makeDelegateTask(SMALL, CWD, APP_DIR);
  const result = await delegate(client, "do a thing");
  assert.equal(result, "(no result)");
});

test("a tool_calls response runs a real command and continues the loop", async () => {
  let callIndex = 0;
  const client = {
    chat: async () => {
      callIndex += 1;
      return callIndex === 1 ? toolCallResponse("echo sub-real-output") : finalResponse("done");
    },
  } as unknown as Ollama;
  const delegate = makeDelegateTask(SMALL, CWD, APP_DIR);
  const result = await delegate(client, "run echo");
  assert.equal(result, "done");
});

test("ANY exception bails out IMMEDIATELY with the delegation-failed message — no retry, no escalation", async () => {
  let callCount = 0;
  const client = {
    chat: async () => {
      callCount += 1;
      throw new Error("small model unreachable");
    },
  } as unknown as Ollama;
  const delegate = makeDelegateTask(SMALL, CWD, APP_DIR);
  const result = await delegate(client, "do a thing");
  assert.equal(callCount, 1, "must not retry after a failure — there is nowhere to escalate to");
  assert.match(result, /Delegation failed: small model unreachable\. Handle this subtask yourself\./);
});

test("a repeated identical command within the subtask is NOT re-executed, and substitutes silently (no console echo of a fresh $ command)", async () => {
  const marker = join(tmpdir(), `eds-tui-subagent-test-${Date.now()}-${Math.random()}`);
  rmSync(marker, { force: true });
  let callIndex = 0;
  const cmd = `echo hit >> ${marker} && echo cache-probe`;
  const client = {
    chat: async () => {
      callIndex += 1;
      if (callIndex === 1) return toolCallResponse(cmd);
      if (callIndex === 2) return toolCallResponse(cmd); // identical repeat
      return finalResponse("wrapped up");
    },
  } as unknown as Ollama;

  const delegate = makeDelegateTask(SMALL, CWD, APP_DIR);
  const result = await delegate(client, "run twice");
  assert.equal(result, "wrapped up");

  const hits = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean) : [];
  assert.equal(hits.length, 1, "the underlying command must only have actually executed once");
  rmSync(marker, { force: true });
});

test("exhausting SUBAGENT_MAX_TURNS salvages via one more no-tools call, wrapped with the step-limit note", async () => {
  const client = {
    chat: async (req: any) =>
      req.tools === undefined ? finalResponse("best guess from partial evidence") : toolCallResponse("echo tick"),
  } as unknown as Ollama;

  const delegate = makeDelegateTask(SMALL, CWD, APP_DIR);
  const result = await delegate(client, "keep going forever");

  assert.match(result!, new RegExp(`hit its ${SUBAGENT_MAX_TURNS}-step limit; this is its best`));
  assert.match(result!, /best guess from partial evidence/);
});

test("exhausting SUBAGENT_MAX_TURNS with the salvage call ALSO failing returns the canned no-conclusion message", async () => {
  const client = {
    chat: async (req: any) => {
      if (req.tools === undefined) throw new Error("salvage call failed too");
      return toolCallResponse("echo tick");
    },
  } as unknown as Ollama;

  const delegate = makeDelegateTask(SMALL, CWD, APP_DIR);
  const result = await delegate(client, "keep going forever");

  assert.match(result!, new RegExp(`hit its ${SUBAGENT_MAX_TURNS}-step limit without a conclusive`));
});

test("view_image: the sub-agent sees the picture in its next request, after the round's tool results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-subagent-image-"));
  try {
    writeFileSync(join(dir, "s.png"), twoColorPng([255, 0, 0], [0, 0, 255]));
    const requests: any[] = [];
    const client = {
      chat: async (req: any) => {
        requests.push(structuredClone(req));
        if (requests.length > 1) return finalResponse("red and blue");
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "view_image", arguments: { path: "s.png" } } },
              { function: { name: "run_command", arguments: { command: "echo listed" } } },
            ],
          } as Message,
        };
      },
    } as unknown as Ollama;
    const result = await makeDelegateTask(SMALL, dir, APP_DIR)(client, "what colors is s.png?");
    assert.equal(result, "red and blue");
    assert.ok(requests[0].tools.some((t: any) => t.function.name === "view_image"));
    const sent: Message[] = requests[1].messages;
    assert.deepEqual(sent.slice(-3).map((m) => m.role), ["tool", "tool", "user"]);
    assert.match(sent[sent.length - 3]!.content, /Loaded .*s\.png/);
    assert.equal(sent[sent.length - 1]!.images?.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
