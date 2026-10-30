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
  [`${N98}/api/ps`]: { models: [{ name: "qwen3.8:latest" }] }, // loaded: a found server is only used with a loaded model
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

test("discoverNodes: helpers (any chat model of 3B+) on peers without qwen3.8, biggest first, never cloud or fine-tunes", async () => {
  const P9 = "http://100.85.150.29:11434", P4 = "http://100.96.62.59:11434", MIXED = "http://100.1.2.3:11434";
  const LAPTOP = "http://100.119.109.55:11434", TAGGED = "http://100.4.5.6:11434";
  const PI = "http://100.105.12.82:11434", EMBED = "http://100.7.8.9:11434";
  const servers: Record<string, unknown> = {
    ...SERVERS,
    [P9]: { models: [
      { name: "qwen3.5:4b", digest: "c1", details: { parameter_size: "4.7B" } },
      { name: "qwen3.5:9b", digest: "c2", details: { parameter_size: "9.7B" } },
      { name: "rasa-judge-qwen3-8b:latest", digest: "c3", details: { parameter_size: "8.2B" } },
      { name: "qwen3.5:397b-cloud", digest: "c4" },
    ] },
    [`${P9}/api/ps`]: { models: [{ name: "qwen3.5:9b" }, { name: "qwen3.5:4b" }] },
    [P4]: { models: [{ name: "qwen3:4b", digest: "d1", details: { parameter_size: "4.0B" } }, { name: "qwen3.5:2b", digest: "d2", details: { parameter_size: "2.3B" } }] },
    [`${P4}/api/ps`]: { models: [{ name: "qwen3.5:2b" }] }, // loaded: no model swap
    [MIXED]: { models: [{ name: "qwen3.8:latest", digest: "e1" }, { name: "qwen3.5:4b", digest: "e2", details: { parameter_size: "4.7B" } }] },
    [`${MIXED}/api/ps`]: { models: [{ name: "qwen3.8:latest" }, { name: "qwen3.5:4b" }] },
    [LAPTOP]: { models: [{ name: "qwen3.8:27b", digest: "f1" }, { name: "qwen3:4b", digest: "f2", details: { parameter_size: "4.0B" } }] },
    [`${LAPTOP}/api/ps`]: { models: [] }, // nothing loaded: never made to load it
    [TAGGED]: { models: [{ name: "qwen3.8:27b", digest: "g1" }] },
    [`${TAGGED}/api/ps`]: { models: [{ name: "qwen3.8:27b" }] },
    // not a qwen: the Raspberry Pi's lfm2.5 helps too; its 1.7B beside it doesn't
    [PI]: { models: [
      { name: "lfm2.5:latest", digest: "h1", details: { parameter_size: "8.47B", family: "lfm2moe" } },
      { name: "hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M", digest: "h2", details: { parameter_size: "1.73B", family: "lfm3" } },
    ] },
    [`${PI}/api/ps`]: { models: [{ name: "lfm2.5:latest" }, { name: "hf.co/LiquidAI/LFM3-1.7B-GGUF:Q4_K_M" }] },
    [EMBED]: { models: [{ name: "granite-text:278m", digest: "i1", details: { parameter_size: "4B", family: "nomic-bert" } }] },
    [`${EMBED}/api/ps`]: { models: [{ name: "granite-text:278m" }] },
  };
  const fetchAll = (async (url: string) => {
    const body = servers[url.replace(/\/api\/tags$/, "")];
    if (!body) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const d = await discoverNodes({ model: "qwen3.8:latest", configured: [RUNPOD], candidates: async () => [N98, P4, P9, MIXED, LAPTOP, TAGGED, PI, EMBED], fetchFn: fetchAll });
  assert.deepEqual(d.urls, [N98, MIXED, TAGGED], "a qwen3.8 server with small qwens too is a qwen3.8 server");
  assert.deepEqual(d.models, { [TAGGED]: "qwen3.8:27b" }, "qwen3.8 under another tag, sent under that tag");
  assert.deepEqual(d.idle, [{ url: LAPTOP, model: "qwen3.8:27b" }], "not loaded: listed, never used");
  assert.deepEqual(d.small, [
    { url: P9, model: "qwen3.5:9b", params: 9.7 },
    { url: PI, model: "lfm2.5:latest", params: 8.47 },
  ], "P4's 2.3B is too small to help, EMBED is an embedding model");
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
