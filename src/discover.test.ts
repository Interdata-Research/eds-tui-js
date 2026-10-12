import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCached, discoverNodes } from "./discover.js";

const RUNPOD = "https://pod-11434.proxy.runpod.net";
const RUNPOD_TS = "http://100.65.113.6:11434"; // the same pod, by its Tailscale address
const N98 = "http://100.98.75.95:11434";
const OTHER = "http://100.118.40.25:11434"; // an Ollama without qwen3.8

const pod = { models: [{ name: "qwen3.8:latest", digest: "aa", modified_at: "2026-10-11T04:46:58Z" }] };
const SERVERS: Record<string, unknown> = {
  [RUNPOD]: pod,
  [RUNPOD_TS]: pod,
  [N98]: { models: [{ name: "qwen3.8:latest", digest: "aa", modified_at: "2026-10-02T22:13:13-04:00" }] },
  [OTHER]: { models: [{ name: "llama3.2:3b", digest: "bb", modified_at: "2026-09-01T00:00:00Z" }] },
};

function fetchFn(seen: string[] = []) {
  return (async (url: string) => {
    const base = url.replace(/\/api\/tags$/, "");
    seen.push(base);
    const body = SERVERS[base];
    if (!body) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

const peers = async () => [RUNPOD_TS, N98, OTHER, "http://100.1.1.1:11434"];

test("discoverNodes: finds the peers serving the model, and one server under two addresses only once", async () => {
  const d = await discoverNodes({ model: "qwen3.8:latest", configured: [RUNPOD], candidates: peers, fetchFn: fetchFn() });
  assert.deepEqual(d.urls, [N98], "100.65.113.6 is RunPod again; the llama-only and silent peers don't count");
  assert.deepEqual(d.duplicates, { [RUNPOD_TS]: RUNPOD }, "the configured address wins");
});

test("discoverNodes: a configured server is never added again", async () => {
  const d = await discoverNodes({ model: "qwen3.8:latest", configured: [RUNPOD, N98], candidates: peers, fetchFn: fetchFn() });
  assert.deepEqual(d.urls, []);
});

test("discoverCached: uses the cache while it's fresh and for the same setup, looks again otherwise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-discover-"));
  try {
    const path = join(dir, "discovered.json");
    let t = 1_000_000;
    const seen: string[] = [];
    const o = { model: "qwen3.8:latest", configured: [RUNPOD], candidates: peers, fetchFn: fetchFn(seen), path, now: () => t };
    assert.deepEqual((await discoverCached(o)).urls, [N98]);
    const looked = seen.length;
    assert.deepEqual((await discoverCached(o)).urls, [N98]);
    assert.equal(seen.length, looked, "cached: no network");
    await discoverCached({ ...o, configured: [RUNPOD, N98] });
    assert.ok(seen.length > looked, "a different configuration looks again");
    const again = seen.length;
    t += 11 * 60_000;
    await discoverCached({ ...o, configured: [RUNPOD, N98] });
    assert.ok(seen.length > again, "a stale cache looks again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
