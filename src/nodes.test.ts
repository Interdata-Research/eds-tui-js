import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeConfig, probeNode, withNodeRouting } from "./nodes.js";

const NODE = "https://pod-11434.proxy.runpod.net";
const LAST = "http://100.98.75.95:11434";

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

test("loadNodeConfig: env wins per list, is comma-separated, trims trailing slashes, drops non-URLs", () => {
  withTempFile(JSON.stringify({ nodes: ["https://from-file"], lastResort: [`${LAST}/`] }), (path) => {
    const cfg = loadNodeConfig({ EDS_TUI_DIRECT_NODES: ` ${NODE}/ , junk, http://lan:11434` }, path);
    assert.deepEqual(cfg.direct, [NODE, "http://lan:11434"]);
    assert.deepEqual(cfg.lastResort, [LAST], "the other list still comes from the file");
    assert.deepEqual(loadNodeConfig({ EDS_TUI_DIRECT_NODES: "", EDS_TUI_LAST_RESORT_NODES: "" }, path), { direct: [], lastResort: [], tokens: {} }, "empty env vars turn the lists off");
  });
});

test("loadNodeConfig: falls back to the file, and to none when it is missing or bad", () => {
  withTempFile(JSON.stringify({ nodes: [`${NODE}/`] }), (path) => assert.deepEqual(loadNodeConfig({}, path), { direct: [NODE], lastResort: [], tokens: {} }));
  withTempFile(null, (path) => assert.deepEqual(loadNodeConfig({}, path), { direct: [], lastResort: [], tokens: {} }));
  withTempFile("{not json", (path) => assert.deepEqual(loadNodeConfig({}, path), { direct: [], lastResort: [], tokens: {} }));
});

test("loadNodeConfig: an entry can be {url, token} (a node behind an authenticating proxy, possibly under a path)", () => {
  const proxied = "http://98.116.214.11:11434/nvidia1";
  withTempFile(JSON.stringify({ lastResort: [{ url: `${proxied}/`, token: " s3cret " }, LAST, { url: "not-a-url", token: "x" }] }), (path) => {
    assert.deepEqual(loadNodeConfig({}, path), { direct: [], lastResort: [proxied, LAST], tokens: { [proxied]: "s3cret" } });
  });
});

test("probeNode: sends the node's token as a Bearer header", async () => {
  let auth: string | null = null;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    auth = new Headers(init.headers).get("authorization");
    return new Response(JSON.stringify({ done: true }), { status: 200 });
  }) as unknown as typeof fetch;
  await probeNode(NODE, "qwen3.8:latest", { fetchFn, attempts: 1, token: "s3cret" });
  assert.equal(auth, "Bearer s3cret");
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

/** A client whose chat() streams one reply tagged with where it came from; `fails` = errors thrown by the first calls. */
function fakeClient(from: string, fails: Error[] = [], alwaysFail = false) {
  const seen: any[] = [];
  const client: any = {
    chat: async (req: any) => {
      seen.push(req);
      const fail = alwaysFail ? fails[0] : fails[seen.length - 1];
      if (fail) throw fail;
      return (async function* () {
        yield { done: true, message: { role: "assistant", content: `from ${from}` } };
      })();
    },
  };
  return { client, seen };
}

const RESET = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
const GATEWAY = Object.assign(new Error("HTTP 502 Bad Gateway"), { status_code: 502 });

interface SetupOptions {
  direct?: boolean[]; // probe results for the direct node; omitted = no direct node
  last?: boolean[]; // probe results for the last-resort node; omitted = no last-resort node
  hubFails?: Error[];
  directFail?: Error;
  lastFail?: Error;
}

function setup(o: SetupOptions) {
  const hub = fakeClient("hub", o.hubFails);
  const direct = fakeClient("direct", o.directFail ? [o.directFail] : [], true);
  const last = fakeClient("last resort", o.lastFail ? [o.lastFail] : [], true);
  const probes: string[] = [];
  const counts = new Map<string, number>();
  let t = 0;
  const changes: string[] = [];
  const retries: string[] = [];
  withNodeRouting(
    hub.client,
    { direct: o.direct ? [NODE] : [], lastResort: o.last ? [LAST] : [] },
    {
      probe: async (url) => {
        probes.push(url);
        const results = url === NODE ? o.direct! : o.last!;
        const n = counts.get(url) ?? 0;
        counts.set(url, n + 1);
        const ok = results[Math.min(n, results.length - 1)]!;
        return { ok, detail: ok ? "2 quick checks passed" : "check 1: no reply within 3s" };
      },
      makeClient: (url) => (url === NODE ? direct.client : last.client),
      onStateChange: (url, usable) => changes.push(`${url === NODE ? "direct" : "last"} ${usable ? "usable" : "skipped"}`),
      now: () => t,
      retry: { delaysMs: [0, 0], sleep: async () => {}, onRetry: (_a, _n, why) => retries.push(why) },
    }
  );
  return { hub, direct, last, probes, changes, retries, advance: (ms: number) => (t += ms) };
}

const ask = (s: ReturnType<typeof setup>) => s.hub.client.chat({ model: "qwen3.8:latest", messages: [] });

test("routing: a direct node that passes its quick checks gets the request", async () => {
  const s = setup({ direct: [true] });
  assert.equal((await ask(s)).message.content, "from direct");
  assert.equal(s.hub.seen.length, 0);
  assert.deepEqual(s.changes, ["direct usable"]);
});

test("routing: a direct node that fails its checks is skipped for the hub, and not re-checked until the cache expires", async () => {
  const s = setup({ direct: [false] });
  assert.equal((await ask(s)).message.content, "from hub");
  assert.equal((await ask(s)).message.content, "from hub");
  assert.equal(s.probes.length, 1, "a failed node is not re-probed on every request");
  assert.equal(s.direct.seen.length, 0);
  s.advance(61_000);
  await ask(s);
  assert.equal(s.probes.length, 2, "re-checked once the failure cache expires");
});

test("routing: a direct request that fails falls back to the hub and marks the node skipped", async () => {
  const s = setup({ direct: [true], directFail: RESET });
  assert.equal((await ask(s)).message.content, "from hub");
  assert.equal(s.direct.seen.length, 1, "no same-node retry: straight to the hub");
  assert.deepEqual(s.changes, ["direct usable", "direct skipped"]);
  await ask(s);
  assert.equal(s.direct.seen.length, 1, "the failed node is skipped next time too");
});

test("routing: the last resort is left alone while the hub answers — not even checked", async () => {
  const s = setup({ last: [true] });
  assert.equal((await ask(s)).message.content, "from hub");
  assert.deepEqual(s.probes, []);
  assert.equal(s.last.seen.length, 0);
});

test("routing: when the hub's first attempt fails, the last resort (after its checks) answers", async () => {
  const s = setup({ last: [true], hubFails: [GATEWAY] });
  assert.equal((await ask(s)).message.content, "from last resort");
  assert.equal(s.hub.seen.length, 1, "only one hub attempt before the last resort");
  assert.deepEqual(s.probes, [LAST]);
  assert.deepEqual(s.retries, ["HTTP 502 Bad Gateway"]);
});

test("routing: a hub refusal that isn't retryable (no node available) also goes to the last resort", async () => {
  const noBackend = Object.assign(new Error("Model 'qwen3.8:latest' is not available through this relay"), { status_code: 403 });
  const s = setup({ last: [true], hubFails: [noBackend] });
  assert.equal((await ask(s)).message.content, "from last resort");
});

test("routing: a last resort that fails its checks leaves the request to the hub's retries", async () => {
  const s = setup({ last: [false], hubFails: [GATEWAY] });
  assert.equal((await ask(s)).message.content, "from hub");
  assert.equal(s.last.seen.length, 0);
  assert.equal(s.hub.seen.length, 2, "first attempt, then the retrying hub");
});

test("routing: order is direct, hub, last resort, hub", async () => {
  const s = setup({ direct: [false], last: [true], hubFails: [GATEWAY] });
  assert.equal((await ask(s)).message.content, "from last resort");
  assert.deepEqual(s.probes, [NODE, LAST]);
});

test("routing: no nodes configured still gets the hub's retries", async () => {
  const s = setup({ hubFails: [GATEWAY] });
  assert.equal((await ask(s)).message.content, "from hub");
  assert.equal(s.hub.seen.length, 2);
});
