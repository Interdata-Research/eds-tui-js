import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNodeConfig, parallelSlots, probeNode, withNodeRouting, type NodeRoutingOptions } from "./nodes.js";
import { memoryLeases } from "./leases.js";
import { useQuirksFile } from "./stream-quirks.js";

useQuirksFile(join(mkdtempSync(join(tmpdir(), "eds-tui-quirks-")), "stream-quirks.json")); // never the real ~/.eds_tui

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
    assert.deepEqual(loadNodeConfig({ EDS_TUI_DIRECT_NODES: "", EDS_TUI_LAST_RESORT_NODES: "" }, path), { direct: [], lastResort: [], tokens: {}, slots: {}, discover: false }, "empty env vars turn the lists (and looking for more) off");
  });
});

test("loadNodeConfig: falls back to the file, and to none when it is missing or bad", () => {
  const none = { tokens: {}, slots: {}, discover: true };
  withTempFile(JSON.stringify({ nodes: [`${NODE}/`] }), (path) => assert.deepEqual(loadNodeConfig({}, path), { direct: [NODE], lastResort: [], ...none }));
  withTempFile(null, (path) => assert.deepEqual(loadNodeConfig({}, path), { direct: [], lastResort: [], ...none }));
  withTempFile("{not json", (path) => assert.deepEqual(loadNodeConfig({}, path), { direct: [], lastResort: [], ...none }));
});

test("loadNodeConfig: an entry can be {url, token} (a node behind an authenticating proxy, possibly under a path)", () => {
  const proxied = "http://98.116.214.11:11434/nvidia1";
  withTempFile(JSON.stringify({ lastResort: [{ url: `${proxied}/`, token: " s3cret " }, LAST, { url: "not-a-url", token: "x" }] }), (path) => {
    assert.deepEqual(loadNodeConfig({}, path), { direct: [], lastResort: [proxied, LAST], tokens: { [proxied]: "s3cret" }, slots: {}, discover: true });
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
      leases: memoryLeases(),
      ranking: () => ({}), // never ~/.eds_tui/ranking.json
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

test("loadNodeConfig: an entry can say how many requests it takes at once; EDS_TUI_DISCOVER=0 or \"discover\": false stop looking for more", () => {
  withTempFile(JSON.stringify({ nodes: [{ url: NODE, slots: 4 }, { url: LAST, slots: 0 }, "http://n3:11434"] }), (path) => {
    const cfg = loadNodeConfig({}, path);
    assert.deepEqual(cfg.slots, { [NODE]: 4 }, "a bad slot count falls back to the default of 1");
    assert.equal(parallelSlots(cfg), 6);
    assert.equal(parallelSlots(cfg, ["http://found:11434", NODE]), 7, "found servers add one each; known ones aren't counted twice");
    assert.equal(loadNodeConfig({ EDS_TUI_DISCOVER: "0" }, path).discover, false);
  });
  withTempFile(JSON.stringify({ discover: false }), (path) => assert.equal(loadNodeConfig({}, path).discover, false));
});

/** Direct nodes whose replies take `ms`; records which node each request reached. */
function parallelSetup(nodeSlots: Record<string, number>, discovered?: string[], ms = 30, extra: Partial<NodeRoutingOptions> = {}) {
  const order: string[] = [];
  const slow = (from: string) => ({
    chat: async () => {
      order.push(from);
      return (async function* () {
        await new Promise((r) => setTimeout(r, ms));
        yield { done: true, message: { role: "assistant", content: `from ${from}` } };
      })();
    },
  });
  const hub = slow("hub") as any;
  const urls = Object.keys(nodeSlots);
  withNodeRouting(
    hub,
    { direct: discovered ? urls.slice(0, 1) : urls, lastResort: [], slots: nodeSlots },
    {
      probe: async () => ({ ok: true, detail: "ok" }),
      makeClient: (url) => slow(url) as any,
      retry: { delaysMs: [0], sleep: async () => {} },
      leases: memoryLeases(),
      ranking: () => ({}), // never ~/.eds_tui/ranking.json
      discovered: discovered ? Promise.resolve(discovered) : undefined,
      ...extra,
    }
  );
  const many = (n: number) =>
    Promise.all(Array.from({ length: n }, () => hub.chat({ model: "qwen3.8:latest", messages: [] }))).then((rs: any[]) =>
      rs.map((r) => r.message.content.replace("from ", ""))
    );
  return { many, order, hub };
}

test("routing: parallel requests fill the strongest node first, then the next (nothing measured: list order)", async () => {
  const A = "http://runpod", B = "http://n98", C = "http://n3";
  const s = parallelSetup({ [A]: 3, [B]: 1, [C]: 1 });
  const got = await s.many(5);
  assert.deepEqual(s.order, [A, A, A, B, C]);
  assert.deepEqual([...got].sort(), [A, A, A, B, C].sort());
});

test("routing: measured, RunPod (4 slots, 5.5s) before the spark (1 slot, 4.8s) before vps-3 (17s): Edgar's order", async () => {
  const RP = "http://runpod", SPARK = "relay:Home", V3 = "http://100.98.75.95:11434";
  const ranking = () => ({ [RP]: { est: 5.5, at: 1 }, [SPARK]: { est: 4.8, at: 1 }, [V3]: { est: 17, at: 1 } });
  const s = parallelSetup({ [V3]: 1, [SPARK]: 1, [RP]: 4 }, undefined, 30, {
    ranking,
    relay: { url: "https://relay" },
    makeRelayClient: (url) =>
      ({ chat: async () => (s.order.push(url), (async function* () { yield { done: true, message: { role: "assistant", content: `from ${url}` } }; })()) }) as any,
  });
  await s.many(6);
  assert.deepEqual(s.order, [RP, RP, RP, RP, SPARK, V3]);
});

test("routing: the measured strongest server leads, whatever the configured order (a new faster one takes over)", async () => {
  const A = "http://runpod", FAST = "http://new-gpu:11434", SLOW = "http://jetson:11434";
  const ranking = () => ({ [A]: { est: 2, at: 1 }, [FAST]: { est: 0.8, at: 1 }, [SLOW]: { est: 9, at: 1 } });
  const s = parallelSetup({ [A]: 4, [SLOW]: 1 }, [FAST], 30, { ranking });
  await s.many(4);
  // FAST 1/0.8 = 1.25/s, A 4 / (2 × 2.8) = 0.71/s, SLOW 0.11/s: FAST, then A's slots.
  assert.deepEqual(s.order, [FAST, A, A, A]);
});

test("routing: a small job goes to a smaller qwen (biggest first, under its own name) only when every node is full", async () => {
  const A = "http://runpod";
  const sent: Array<[string, string]> = [];
  const small = [
    { url: "http://pez:11434", model: "qwen3.5:9b", params: 9.7 },
    { url: "http://openclaw:11434", model: "qwen3:4b", params: 4 },
  ];
  const s = parallelSetup({ [A]: 1 }, undefined, 30, {
    small: Promise.resolve(small),
    makeClient: (url) =>
      ({
        chat: async (req: any) => {
          sent.push([url, req.model]);
          return (async function* () {
            await new Promise((r) => setTimeout(r, 30));
            yield { done: true, message: { role: "assistant", content: `from ${url}` } };
          })();
        },
      }) as any,
  });
  await new Promise((r) => setTimeout(r, 0)); // the small list resolves
  const tools = [{ type: "function", function: { name: "run" } }];
  const [a, small1, agentic] = await Promise.all([
    s.hub.chat({ model: "qwen3.8:latest", messages: [] }),
    s.hub.chat({ model: "qwen3.8:latest", messages: [] }),
    s.hub.chat({ model: "qwen3.8:latest", messages: [], tools }),
  ]);
  assert.equal(a.message.content, `from ${A}`);
  assert.equal(small1.message.content, "from http://pez:11434", "no tools: the biggest small qwen");
  assert.deepEqual(sent.find(([u]) => u === "http://pez:11434"), ["http://pez:11434", "qwen3.5:9b"]);
  assert.equal(agentic.message.content, "from hub", "an agentic step (tools) never goes to a small qwen");
});

test("routing: easy terminal work ('helper') goes down the ladder to a helper when every node is full, unless it writes", async () => {
  const A = "http://runpod", PI = "http://pi:11434";
  const got: Array<[string, string, string]> = [];
  const reply = (from: string, message: any, ms = 0) =>
    (async function* () {
      await new Promise((r) => setTimeout(r, ms));
      yield { done: true, message: { role: "assistant", ...message } };
    })();
  const calls: Record<string, any> = {
    ls: { content: "", tool_calls: [{ function: { name: "run_command", arguments: { command: "ls -la /var/log" } } }] },
    rm: { content: "", tool_calls: [{ function: { name: "run_command", arguments: { command: "rm -rf /tmp/x" } } }] },
    junk: { content: "" }, // an empty reply: the helper's fault
  };
  const hub = {
    chat: async (req: any) => (got.push(["hub", req.model, req.messages.at(-1)?.content]), reply("hub", { content: "from hub" })),
  } as any;
  withNodeRouting(hub, { direct: [A], lastResort: [], slots: { [A]: 1 } }, {
    probe: async () => ({ ok: true, detail: "ok" }),
    makeClient: (url) =>
      ({
        chat: async (req: any) => {
          const word = req.messages.at(-1)?.content;
          got.push([url, req.model, word]);
          return url === PI ? reply(url, calls[word] ?? { content: `from ${url}` }) : reply(url, { content: `from ${url}` }, 300);
        },
      }) as any,
    retry: { delaysMs: [0], sleep: async () => {} },
    leases: memoryLeases(),
    ranking: () => ({}),
    small: Promise.resolve([{ url: PI, model: "lfm2.5:latest", params: 8.47 }]),
    mainModel: "qwen3.8:latest",
  });
  await new Promise((r) => setTimeout(r, 0));
  const tools = [{ type: "function", function: { name: "run_command" } }];
  const step = (word: string) => hub.chat({ model: "helper", messages: [{ role: "user", content: word }], tools });
  const idle = await step("ls");
  assert.equal(idle.message.content, `from ${A}`, "an idle node takes it, as the main model");
  assert.deepEqual(got.at(-1), [A, "qwen3.8:latest", "ls"]);
  const [, reads, writes] = await Promise.all([step("busy"), step("ls"), step("rm")]);
  assert.equal(reads.message.tool_calls[0].function.arguments.command, "ls -la /var/log", "the helper's read is handed back");
  assert.equal(writes.message.content, "from hub", "a write goes on to the main model (the hub)");
  assert.ok(got.some(([u, m]) => u === PI && m === "lfm2.5:latest"));
  assert.ok(got.filter(([u]) => u === "hub").every(([, m]) => m === "qwen3.8:latest"), "the hub never sees 'helper'");
  const [, junk] = await Promise.all([step("busy"), step("junk")]);
  assert.equal(junk.message.content, "from hub");
  got.length = 0;
  const [, after] = await Promise.all([step("busy"), step("ls")]);
  assert.equal(after.message.content, "from hub", "after an empty step this run stays off helpers");
  assert.ok(!got.some(([u]) => u === PI));
  const plain = await hub.chat({ model: "qwen3.8:latest", messages: [{ role: "user", content: "x" }], tools });
  assert.equal(plain.message.content, `from ${A}`);
});

test("routing: through the relay pinned to the node (its tailnet twin's name), straight when the relay can't", async () => {
  const A = "https://pod-11434.proxy.runpod.net";
  const pinned: string[] = [];
  let relayWorks = true;
  const reply = (from: string) =>
    (async function* () {
      yield { done: true, message: { role: "assistant", content: `from ${from}` } };
    })();
  const s = parallelSetup({ [A]: 2 }, undefined, 30, {
    relay: { url: "https://relay", token: "k", names: Promise.resolve({ [A]: "http://100.65.113.6:11434" }) },
    makeRelayClient: (_url, name) =>
      ({
        chat: async () => {
          pinned.push(name);
          if (!relayWorks) throw Object.assign(new Error("Node is not available through this relay"), { status_code: 503 });
          return reply(`relay → ${name}`);
        },
      }) as any,
    makeClient: (url) => ({ chat: async () => reply(url) }) as any,
  });
  await new Promise((r) => setTimeout(r, 0)); // the names resolve
  assert.deepEqual(await s.many(1), ["relay → http://100.65.113.6:11434"]);
  relayWorks = false;
  assert.deepEqual(await s.many(1), [A], "the relay refused: straight, same request");
  assert.deepEqual(await s.many(1), [A], "and straight for a while, without asking the relay again");
  assert.equal(pinned.length, 2);
});

test("loadNodeConfig: \"router\" (the AI Command Center's) from the file or EDS_TUI_ROUTER_URL / _TOKEN", () => {
  withTempFile(JSON.stringify({ router: { url: "http://127.0.0.1:8130/llm/", token: " t " } }), (path) => {
    assert.deepEqual(loadNodeConfig({}, path).router, { url: "http://127.0.0.1:8130/llm", token: "t" });
    assert.deepEqual(loadNodeConfig({ EDS_TUI_ROUTER_URL: "http://other:8130/llm", EDS_TUI_ROUTER_TOKEN: "" }, path).router, {
      url: "http://other:8130/llm",
    });
  });
  withTempFile(JSON.stringify({ router: { url: "not a url" } }), (path) => assert.equal(loadNodeConfig({}, path).router, undefined));
});

test("routing: when every node's slots are full, the rest go to the hub instead of waiting", async () => {
  const A = "http://runpod", B = "http://n98";
  const s = parallelSetup({ [A]: 2, [B]: 1 });
  assert.deepEqual((await s.many(5)).sort(), [A, A, B, "hub", "hub"].sort());
  // ...and once they're done, the nodes are free again.
  assert.deepEqual((await s.many(1)), [A]);
});

test("routing: servers found on the network join the direct nodes with one slot each", async () => {
  const A = "http://runpod", FOUND = "http://100.98.75.95:11434";
  const s = parallelSetup({ [A]: 1 }, [FOUND]);
  assert.deepEqual((await s.many(3)).sort(), [A, FOUND, "hub"].sort());
});

test("a relay-only node ({\"relay\": \"Home\"}): parsed, checked and sent through the relay pinned to it, never straight", async () => {
  withTempFile(JSON.stringify({ nodes: [{ url: NODE, slots: 4 }, { relay: "Home", slots: 1 }, "relay:", { relay: " " }] }), (path) => {
    const cfg = loadNodeConfig({}, path);
    assert.deepEqual(cfg.direct, [NODE, "relay:Home"]);
    assert.deepEqual(cfg.slots, { [NODE]: 4, "relay:Home": 1 });
  });
  const pinned: string[] = [];
  const straight: string[] = [];
  const reply = (from: string) =>
    (async function* () {
      yield { done: true, message: { role: "assistant", content: `from ${from}` } };
    })();
  const s = parallelSetup({ "relay:Home": 1 }, undefined, 30, {
    relay: { url: "https://relay", token: "k" },
    makeRelayClient: (_url, name) => ({ chat: async () => (pinned.push(name), reply(`relay → ${name}`)) }) as any,
    makeClient: (url) => ({ chat: async () => (straight.push(url), reply(url)) }) as any,
  });
  assert.deepEqual(await s.many(1), ["relay → Home"]);
  assert.deepEqual([pinned, straight], [["Home"], []]);
});
