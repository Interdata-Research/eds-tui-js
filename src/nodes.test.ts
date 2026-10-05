import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDirectNodes, probeNode, withDirectNodes } from "./nodes.js";
import { withRetries } from "./retry.js";

const NODE = "https://pod-11434.proxy.runpod.net";

function withTempFile(contents: string | null, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-nodes-test-"));
  const path = join(dir, "nodes.json");
  if (contents !== null) writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadDirectNodes: env wins, is comma-separated, trims trailing slashes, drops non-URLs", () => {
  withTempFile(JSON.stringify({ nodes: ["https://from-file"] }), (path) => {
    assert.deepEqual(loadDirectNodes({ EDS_TUI_DIRECT_NODES: ` ${NODE}/ , junk, http://lan:11434` }, path), [NODE, "http://lan:11434"]);
    assert.deepEqual(loadDirectNodes({ EDS_TUI_DIRECT_NODES: "" }, path), [], "an empty env var turns direct nodes off");
  });
});

test("loadDirectNodes: falls back to the file, and to none when it is missing or bad", () => {
  withTempFile(JSON.stringify({ nodes: [`${NODE}/`] }), (path) => assert.deepEqual(loadDirectNodes({}, path), [NODE]));
  withTempFile(null, (path) => assert.deepEqual(loadDirectNodes({}, path), []));
  withTempFile("{not json", (path) => assert.deepEqual(loadDirectNodes({}, path), []));
});

function fakeFetch(replies: Array<"ok" | "hang" | number>) {
  let i = 0;
  const fn = (async (_url: string, init: RequestInit) => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r === "hang") {
      return new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
      );
    }
    if (typeof r === "number") return new Response("{}", { status: r });
    return new Response(JSON.stringify({ done: true, message: { content: "h" } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls: () => i };
}

test("probeNode: healthy only if every quick check returns a reply in time", async () => {
  const good = fakeFetch(["ok"]);
  assert.equal((await probeNode(NODE, "qwen3.8:latest", { fetchFn: good.fn, attempts: 2 })).ok, true);
  assert.equal(good.calls(), 2);

  const wedged = fakeFetch(["hang"]);
  const r = await probeNode(NODE, "qwen3.8:latest", { fetchFn: wedged.fn, attempts: 2, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.detail, /no reply within/);
  assert.equal(wedged.calls(), 1, "stops at the first failed check");

  const flaky = fakeFetch(["ok", 524]);
  assert.deepEqual(await probeNode(NODE, "qwen3.8:latest", { fetchFn: flaky.fn, attempts: 2 }), { ok: false, detail: "check 2: HTTP 524" });
});

/** A client whose chat() streams one reply tagged with where it came from. */
function fakeClient(from: string, fail?: Error) {
  const seen: any[] = [];
  const client: any = {
    chat: async (req: any) => {
      seen.push(req);
      if (fail) throw fail;
      return (async function* () {
        yield { done: true, message: { role: "assistant", content: `from ${from}` } };
      })();
    },
  };
  return { client, seen };
}

function setup(probeResults: boolean[], directFail?: Error) {
  const hub = fakeClient("hub");
  const direct = fakeClient("direct", directFail);
  let probes = 0;
  let t = 0;
  const changes: string[] = [];
  withRetries(hub.client, { delaysMs: [] });
  withDirectNodes(hub.client, [NODE], {
    probe: async () => {
      const ok = probeResults[Math.min(probes++, probeResults.length - 1)]!;
      return { ok, detail: ok ? "2 quick checks passed" : "check 1: no reply within 3s" };
    },
    makeClient: () => direct.client,
    onStateChange: (_u, usable) => changes.push(usable ? "usable" : "skipped"),
    now: () => t,
  });
  return { hub, direct, probes: () => probes, changes, advance: (ms: number) => (t += ms) };
}

test("withDirectNodes: a node that passes its quick checks gets the request", async () => {
  const s = setup([true]);
  const res = await s.hub.client.chat({ model: "qwen3.8:latest", messages: [] });
  assert.equal(res.message.content, "from direct");
  assert.equal(s.hub.seen.length, 0);
  assert.deepEqual(s.changes, ["usable"]);
});

test("withDirectNodes: a node that fails its checks is skipped for the hub, and not re-checked until the cache expires", async () => {
  const s = setup([false]);
  assert.equal((await s.hub.client.chat({ model: "qwen3.8:latest", messages: [] })).message.content, "from hub");
  assert.equal((await s.hub.client.chat({ model: "qwen3.8:latest", messages: [] })).message.content, "from hub");
  assert.equal(s.probes(), 1, "a failed node is not re-probed on every request");
  assert.equal(s.direct.seen.length, 0);
  s.advance(61_000);
  await s.hub.client.chat({ model: "qwen3.8:latest", messages: [] });
  assert.equal(s.probes(), 2, "re-checked once the failure cache expires");
});

test("withDirectNodes: a direct request that fails falls back to the hub and marks the node skipped", async () => {
  const s = setup([true], Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }));
  const res = await s.hub.client.chat({ model: "qwen3.8:latest", messages: [] });
  assert.equal(res.message.content, "from hub");
  assert.equal(s.direct.seen.length, 1, "no same-node retry: straight to the hub");
  assert.deepEqual(s.changes, ["usable", "skipped"]);
  await s.hub.client.chat({ model: "qwen3.8:latest", messages: [] });
  assert.equal(s.direct.seen.length, 1, "the failed node is skipped next time too");
});

test("withDirectNodes: no configured nodes leaves the client untouched", () => {
  const hub = fakeClient("hub");
  const chat = hub.client.chat;
  withDirectNodes(hub.client, []);
  assert.equal(hub.client.chat, chat);
});
