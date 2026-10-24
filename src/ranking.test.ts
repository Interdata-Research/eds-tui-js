import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmark, ranked, readRanking, refreshRanking, strength, writeRanking, type Route } from "./ranking.js";
import { memoryLeases } from "./leases.js";

function tempPath(): { path: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-ranking-"));
  return { path: join(dir, "ranking.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("ranked: measured servers by strength (throughput with every slot busy), never-measured ones after, in list order", () => {
  const r = { "http://rp": { est: 5.5, at: 1 }, "http://spark": { est: 4.8, at: 1 }, "http://v3": { est: 17, at: 1 } };
  assert.deepEqual(ranked(["http://new", "http://v3", "http://spark", "http://rp"], r, { "http://rp": 4 }), ["http://rp", "http://spark", "http://v3", "http://new"]);
  assert.equal(strength(r["http://rp"], 4).toFixed(2), "0.26");
  assert.equal(strength(r["http://spark"]).toFixed(2), "0.21");
  assert.deepEqual(ranked(["http://a", "http://b"], {}), ["http://a", "http://b"], "nothing measured: the configured order");
});

test("benchmark: the same long prompt with a random start each time, through the first route that answers", async () => {
  const seen: Array<{ url: string; node: string | null; content: string }> = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push({ url, node: new Headers(init.headers).get("x-interdata-node"), content: body.messages[0].content });
    if (url.startsWith("https://relay")) return new Response(JSON.stringify({ error: "Node isn't available" }), { status: 503 });
    assert.equal(body.options.num_predict, 64);
    return new Response(JSON.stringify({ message: { content: "1 2 3" }, done: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const routes: Route[] = [
    { url: "https://relay", headers: { "X-Interdata-Node": "http://n:11434" } },
    { url: "http://n:11434", headers: {} },
  ];
  const est = await benchmark(routes, "qwen3.8:latest", fetchFn);
  assert.ok(est !== null && est >= 0);
  assert.deepEqual(seen.map((s) => [s.url, s.node]), [["https://relay/api/chat", "http://n:11434"], ["http://n:11434/api/chat", null]]);
  await benchmark(routes.slice(1), "qwen3.8:latest", fetchFn);
  assert.notEqual(seen[1]!.content, seen[2]!.content, "a new random start: no prompt cache helps");
  assert.ok(seen[1]!.content.length > 7000, "a long prompt, as an agentic turn's");
  const failing = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
  assert.equal(await benchmark(routes, "qwen3.8:latest", failing), null);
});

test("refreshRanking: measures stale idle servers only, keeps them in the shared file", async () => {
  const { path, done } = tempPath();
  try {
    let t = 10_000_000;
    const asked: string[] = [];
    const fetchFn = (async (url: string) => {
      asked.push(url);
      return new Response(JSON.stringify({ message: { content: "ok" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const leases = memoryLeases();
    const busy = leases.acquire("http://busy");
    const o = { urls: ["http://a", "http://busy"], model: "m", routesFor: (u: string) => [{ url: u, headers: {} }], leases, path, now: () => t, fetchFn };
    const r = await refreshRanking(o);
    assert.deepEqual(asked, ["http://a/api/chat"], "the busy one waits for another time");
    assert.ok(r["http://a"] && !r["http://busy"]);
    await refreshRanking(o);
    assert.equal(asked.length, 1, "fresh: not measured again");
    t += 31 * 60_000;
    busy();
    await refreshRanking(o);
    assert.equal(asked.length, 3, "stale, and the other one is idle now");
    await refreshRanking({ ...o, force: true });
    assert.equal(asked.length, 5, "ask --nodes measures all of them");
    writeRanking({ "http://other": { est: 1, at: t } }, path);
    assert.ok(readRanking(path)["http://a"], "a write merges, never drops the others");
  } finally {
    done();
  }
});
