import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ollama } from "ollama";
import { loadPool, pickSpecialistModel } from "./model-pool.js";

function withTempFile(contents: string | null, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-model-pool-test-"));
  const path = join(dir, "models.json");
  try {
    if (contents !== null) writeFileSync(path, contents);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadPool: missing file degrades to an empty pool, not an error", () => {
  withTempFile(null, (path) => {
    assert.deepEqual(loadPool(path), []);
  });
});

test("loadPool: malformed JSON degrades to an empty pool", () => {
  withTempFile("{ this is not valid json", (path) => {
    assert.deepEqual(loadPool(path), []);
  });
});

test("loadPool: valid JSON that isn't an array degrades to an empty pool", () => {
  withTempFile(JSON.stringify({ name: "x", good_for: "y" }), (path) => {
    assert.deepEqual(loadPool(path), []);
  });
});

test("loadPool: a well-formed pool round-trips name/good_for", () => {
  withTempFile(
    JSON.stringify([
      { name: "deepseek-r1:8b", good_for: "deep multi-step reasoning and math" },
      { name: "qwen3-coder-next", good_for: "code generation and refactoring" },
    ]),
    (path) => {
      const pool = loadPool(path);
      assert.equal(pool.length, 2);
      assert.deepEqual(pool[0], { name: "deepseek-r1:8b", goodFor: "deep multi-step reasoning and math" });
      assert.deepEqual(pool[1], { name: "qwen3-coder-next", goodFor: "code generation and refactoring" });
    }
  );
});

test("loadPool: entries missing name or good_for are silently skipped, not a throw", () => {
  withTempFile(
    JSON.stringify([
      { name: "ok-model", good_for: "fine" },
      { name: "no-good-for" },
      { good_for: "no name" },
      { name: "", good_for: "blank name" },
      "not even an object",
      null,
    ]),
    (path) => {
      const pool = loadPool(path);
      assert.equal(pool.length, 1);
      assert.equal(pool[0]!.name, "ok-model");
    }
  );
});

const POOL = [
  { name: "deepseek-r1:8b", goodFor: "deep multi-step reasoning, math, logic" },
  { name: "qwen3-coder-next", goodFor: "code generation, refactoring, debugging" },
];

function finalResponse(content: string) {
  return { message: { role: "assistant", content } };
}

test("pickSpecialistModel: empty pool never calls the client, returns null", async () => {
  const client = { chat: async () => { throw new Error("should not be called"); } } as unknown as Ollama;
  const result = await pickSpecialistModel(client, "some task", [], "small-model");
  assert.equal(result, null);
});

test("pickSpecialistModel: matches a real pool entry by name in the reply", async () => {
  const client = { chat: async () => finalResponse("qwen3-coder-next") } as unknown as Ollama;
  const result = await pickSpecialistModel(client, "refactor this code", POOL, "small-model");
  assert.equal(result, "qwen3-coder-next");
});

test("pickSpecialistModel: NONE (or any non-matching reply) returns null, not a throw", async () => {
  const client = { chat: async () => finalResponse("NONE") } as unknown as Ollama;
  const result = await pickSpecialistModel(client, "what's 2+2", POOL, "small-model");
  assert.equal(result, null);
});

test("pickSpecialistModel: a client exception returns null rather than propagating — must never block salvaging an answer another way", async () => {
  const client = { chat: async () => { throw new Error("network down"); } } as unknown as Ollama;
  const result = await pickSpecialistModel(client, "anything", POOL, "small-model");
  assert.equal(result, null);
});

test("pickSpecialistModel: uses the smallModel for the routing call, not any pool entry", async () => {
  let calledWithModel = "";
  const client = {
    chat: async (req: any) => {
      calledWithModel = req.model;
      return finalResponse("deepseek-r1:8b");
    },
  } as unknown as Ollama;
  await pickSpecialistModel(client, "hard reasoning task", POOL, "tiny:1b");
  assert.equal(calledWithModel, "tiny:1b");
});
