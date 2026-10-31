// Direct nodes: qwen3.8 servers `ask` may call directly instead of through
// the interdata hub.
//
// The hub picks a node per request by round robin and offers no way to pick
// or skip one, so a node it still considers healthy (its /api/tags answers
// instantly) can be wedged for generation and cost every other request a
// ~2 minute timeout. For nodes listed here, `ask` checks for itself: before
// sending a request directly, it asks the node for a one-token reply a
// couple of times with a short deadline. Only a node that passes gets the
// request; otherwise — or if the direct request then fails — the request
// goes through the hub, which serves it from the other qwen3.8 nodes in the
// network.
//
// /api/tags and /api/version are deliberately NOT the check: they answered
// in ~0.2s while the same node could not produce one token in 30s.
//
// Last-resort nodes are the same idea one step later: used only when the
// hub's first attempt fails or goes silent (every qwen3.8 it routes to busy
// or not responding), checked the same way first. The order per request:
//   1. direct nodes that pass their checks
//   2. the hub, one attempt
//   3. last-resort nodes that pass their checks
//   4. the hub again, with its full retries
//
// Configured with EDS_TUI_DIRECT_NODES / EDS_TUI_LAST_RESORT_NODES
// (comma-separated URLs) or ~/.eds_tui/nodes.json
// ({"nodes": [...], "lastResort": [...]}); env wins, per list. In the file,
// an entry is a URL string, or {"url": "...", "token": "...", "slots": 4}:
// a token for a node behind a proxy that wants `Authorization: Bearer
// <token>`, and how many requests it may run at once (default 1). A URL may
// carry a path (a proxy that serves a node under a prefix).
//
// Strongest first, in parallel when needed (Edgar, 0.9.0): direct nodes
// aren't tried in list order. Each request goes to the strongest node with a
// free slot (ranking.ts: measured throughput with every slot busy, so a new,
// stronger server leads by itself; leases.ts counts requests in flight across
// every ask on this machine). So RunPod's slots fill first, then the next
// server, and delegate_tasks' sub-agents and parallel asks still run at once.
// Servers found by discover.ts join the direct nodes with one slot each.
// When every node is full (or failing), a small job (no tools: not an agentic
// step) goes to a helper model found on the network (any family, 3B+;
// biggest first, under its own model name), and anything else to the hub.
//
// The ladder (Edgar 2026-10-30, as the AI Command Center's router): a request
// for HELPER_MODEL ("helper", ask's small model while it routes: its SIMPLE
// triage verdicts and delegate_task legwork) is the main model's on every
// node and the hub, and when every node is full a helper takes it, terminal
// tools and all, if what it does only reads (readonly.ts): a write, a step it
// may not take, or a reply too long for it (HELPER_MAX_TOKENS) goes on to
// the hub instead; an empty or garbled reply too, and the rest of this run
// stays off helpers. Helpers learn (experience.ts): for terminal work the
// one with the best record for this kind of task goes first, and one that
// keeps failing at it gets no more of it for a while.
//
// Through the relay: a node's requests go to the hub (the interdata relay)
// with X-Interdata-Node = that node, so the relay logs them while the choice
// stays ours; a node the relay can't take them to is reached straight for a
// minute. A node's name on the relay is its address there (discover.ts gives
// a configured proxy URL's tailnet twin).
//
// Images (vision.ts, 0.10.0): a request carrying images goes only to a node
// that has shown it really sees them — free ones first, strongest first —
// never to the hub or a smaller qwen, which may hand it to one that drops the
// images (RunPod's llama.cpp) and invents the picture. None that sees: an
// error saying so, rather than a made-up answer.
//
// On a machine with the AI Command Center, `"router": {"url", "token"}` in
// nodes.json (or EDS_TUI_ROUTER_URL / EDS_TUI_ROUTER_TOKEN) sends everything
// to its router instead (cli.ts), which does all of the above for every ask
// and task there at once; the relay is the last resort if it's down.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";
import { DEFAULT_MAIN_MODEL, jsonErrors } from "./client.js";
import { describeError, withRetries } from "./retry.js";
import { fileLeases } from "./leases.js";
import { ranked, readRanking } from "./ranking.js";
import { hasImages, knownVision, probeVision, rememberVision } from "./vision.js";
import { helperReplyOk } from "./readonly.js";
import { currentKind, garbled, helped, helperOrder } from "./experience.js";
/** The model name that means "easy work: down the ladder to the helpers when every node is busy". */
export const HELPER_MODEL = "helper";
/** A helper takes terminal work only this long (estimated tokens): a long conversation is too much for the Pi. */
export const HELPER_MAX_TOKENS = 6000;
const estimateTokens = (request) => Math.ceil(JSON.stringify(request?.messages ?? []).length / 3);
export const NODES_FILE = join(homedir(), ".eds_tui", "nodes.json");
function normalizeUrl(u) {
    return u.trim().replace(/\/+$/, "");
}
/** URLs from a list of strings or {url, token, slots} objects; tokens and slots collected by URL. */
/** "relay:<name>": a server reached only through the relay, pinned to its name there (relay-only node). */
export const RELAY_ONLY = "relay:";
export const isRelayOnly = (url) => url.startsWith(RELAY_ONLY);
function clean(entries, tokens, slots) {
    const urls = [];
    for (const entry of entries) {
        // {"relay": "Home"} (or "relay:Home"): a server this machine can't reach itself, through the relay
        const relayOnly = entry?.relay;
        const url = typeof entry === "string" ? entry : typeof relayOnly === "string" ? `${RELAY_ONLY}${relayOnly}` : entry?.url;
        if (typeof url !== "string")
            continue;
        if (url.trim().startsWith(RELAY_ONLY)) {
            const name = url.trim().slice(RELAY_ONLY.length).trim();
            if (!name)
                continue;
            const key = `${RELAY_ONLY}${name}`;
            const n = entry?.slots;
            if (typeof n === "number" && Number.isInteger(n) && n >= 1)
                slots[key] = n;
            urls.push(key);
            continue;
        }
        if (!/^https?:\/\//.test(url.trim()))
            continue;
        const normalized = normalizeUrl(url);
        const token = entry?.token;
        if (typeof token === "string" && token.trim())
            tokens[normalized] = token.trim();
        const n = entry?.slots;
        if (typeof n === "number" && Number.isInteger(n) && n >= 1)
            slots[normalized] = n;
        urls.push(normalized);
    }
    return urls;
}
function authHeaders(token) {
    return token ? { Authorization: `Bearer ${token}` } : {};
}
/** Node lists from EDS_TUI_DIRECT_NODES / EDS_TUI_LAST_RESORT_NODES, else ~/.eds_tui/nodes.json, else none. */
export function loadNodeConfig(env, path = NODES_FILE) {
    let file = {};
    try {
        file = JSON.parse(readFileSync(path, "utf8")) ?? {};
    }
    catch {
        // missing or unreadable file: no nodes from it
    }
    const tokens = {};
    const slots = {};
    const pick = (envValue, fileValue) => envValue !== undefined
        ? clean(envValue.split(","), tokens, slots)
        : Array.isArray(fileValue)
            ? clean(fileValue, tokens, slots)
            : [];
    const cfg = {
        direct: pick(env.EDS_TUI_DIRECT_NODES, file.nodes),
        lastResort: pick(env.EDS_TUI_LAST_RESORT_NODES, file.lastResort),
        tokens,
        slots,
        // An explicit EDS_TUI_DIRECT_NODES is the exact list to use.
        discover: env.EDS_TUI_DISCOVER !== "0" && env.EDS_TUI_DIRECT_NODES === undefined && file.discover !== false,
    };
    const r = (file.router ?? {});
    const routerUrl = env.EDS_TUI_ROUTER_URL ?? (typeof r.url === "string" ? r.url : "");
    if (/^https?:\/\//.test(routerUrl.trim())) {
        const token = env.EDS_TUI_ROUTER_TOKEN ?? (typeof r.token === "string" ? r.token : "");
        cfg.router = { url: normalizeUrl(routerUrl), ...(token.trim() ? { token: token.trim() } : {}) };
    }
    return cfg;
}
/**
 * Can this node generate right now? Asks for a one-token reply `attempts`
 * times; every one must come back done within `timeoutMs`. Stops at the
 * first failure.
 */
export async function probeNode(url, model, opts = {}) {
    const attempts = opts.attempts ?? 2;
    const timeoutMs = opts.timeoutMs ?? 3_000;
    const fetchFn = opts.fetchFn ?? fetch;
    for (let i = 1; i <= attempts; i++) {
        // A plain timer rather than AbortSignal.timeout(): that one's timer doesn't
        // keep the process alive, so a node that hangs could let Node exit mid-check.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetchFn(`${url}/api/chat`, {
                method: "POST",
                headers: { "content-type": "application/json", ...authHeaders(opts.token), ...opts.headers },
                body: JSON.stringify({
                    model,
                    messages: [{ role: "user", content: "hi" }],
                    stream: false,
                    think: false,
                    options: { num_predict: 1 },
                }),
                signal: controller.signal,
            });
            if (!res.ok)
                return { ok: false, detail: `check ${i}: HTTP ${res.status}` };
            const body = (await res.json().catch(() => null));
            if (!body?.done)
                return { ok: false, detail: `check ${i}: no reply` };
        }
        catch (e) {
            return { ok: false, detail: controller.signal.aborted ? `check ${i}: no reply within ${timeoutMs / 1000}s` : `check ${i}: ${describeError(e)}` };
        }
        finally {
            clearTimeout(timer);
        }
    }
    return { ok: true, detail: `${attempts} quick checks passed` };
}
/** A node's name on the relay: a relay-only node's own name, its tailnet twin (a configured proxy URL), else its address. */
export function relayName(url, names = {}) {
    return isRelayOnly(url) ? url.slice(RELAY_ONLY.length) : (names[url] ?? url);
}
/** How many requests the direct nodes can take at once, counting discovered ones. */
export function parallelSlots(nodes, discovered = []) {
    const direct = [...new Set([...nodes.direct, ...discovered])];
    return direct.reduce((n, url) => n + (nodes.slots?.[url] ?? 1), 0);
}
/**
 * Wrap the hub client's `chat` with the routing above. Takes the plain hub
 * client (this applies withRetries itself) and returns the same client.
 */
export function withNodeRouting(hub, nodes, opts = {}) {
    const mainModel = opts.mainModel ?? DEFAULT_MAIN_MODEL;
    const forMain = (req) => (req?.model === HELPER_MODEL ? { ...req, model: mainModel } : req);
    const forHub = (req) => (opts.hubKnowsHelper ? req : forMain(req));
    const plainHubChat = hub.chat.bind(hub);
    const rawHubChat = ((req) => plainHubChat(forHub(req)));
    const hubServer = hub.config?.host;
    const hubWithRetries = withRetries({ chat: rawHubChat }, { ...opts.retry, server: hubServer }).chat;
    if (nodes.direct.length === 0 && nodes.lastResort.length === 0 && !opts.discovered) {
        hub.chat = hubWithRetries;
        return hub;
    }
    // One hub attempt (still re-asking a malformed reply), then on to the last resort.
    const hubOnce = withRetries({ chat: rawHubChat }, { ...opts.retry, delaysMs: [0], retryTransient: false, server: hubServer }).chat;
    const tokens = nodes.tokens ?? {};
    const slots = nodes.slots ?? {};
    const leases = opts.leases ?? fileLeases();
    let direct = nodes.direct;
    let discovering = opts.discovered?.then((found) => {
        direct = [...new Set([...nodes.direct, ...found.filter((u) => !nodes.lastResort.includes(u))])];
    }, () => { } // nothing found: the configured nodes and the hub
    );
    const probe = opts.probe ??
        ((url, model) => isRelayOnly(url)
            ? opts.relay
                ? probeNode(opts.relay.url, model, { token: opts.relay.token, headers: { "X-Interdata-Node": relayName(url) } })
                : Promise.resolve({ ok: false, detail: "reached only through the relay, and no https relay is configured" })
            : probeNode(url, model, { token: tokens[url] }));
    const okCacheMs = opts.okCacheMs ?? 20_000;
    const failCacheMs = opts.failCacheMs ?? 60_000;
    const now = opts.now ?? Date.now;
    const makeClient = opts.makeClient ?? ((url) => new Ollama({ host: url, headers: authHeaders(tokens[url]), fetch: jsonErrors(fetch) }));
    const relay = opts.relay;
    let relayNames = {};
    relay?.names?.then((n) => (relayNames = n), () => { });
    const makeRelayClient = opts.makeRelayClient ??
        ((_url, name) => new Ollama({ host: relay.url, headers: { ...authHeaders(relay.token), "X-Interdata-Node": name }, fetch: jsonErrors(fetch) }));
    const relaySkip = new Map(); // node -> until when it's reached straight
    const ranking = opts.ranking ?? (() => readRanking());
    let small = [];
    opts.small?.then((s) => (small = s), () => { });
    let tagged = {};
    opts.models?.then((m) => (tagged = m), () => { });
    const asNode = (url, request) => (tagged[url] ? { ...request, model: tagged[url] } : request);
    // Node requests get the stream + malformed-tool-call handling, but no
    // same-node retries: any other failure moves on to the next route at once.
    const clients = new Map();
    function clientFor(url, viaRelay) {
        const key = `${viaRelay ? "relay " : ""}${url}`;
        if (!clients.has(key)) {
            const c = viaRelay ? makeRelayClient(url, relayName(url, relayNames)) : makeClient(url);
            clients.set(key, withRetries(c, { ...opts.retry, delaysMs: [0], retryTransient: false, onRetry: undefined, server: url }).chat);
        }
        return clients.get(key);
    }
    /** One request on a node, counted while it runs (from `release`, if the caller already took the slot):
     *  through the relay when it can take it there, else straight. */
    async function send(url, request, release = leases.acquire(url)) {
        try {
            if (isRelayOnly(url)) {
                if (!relay)
                    throw new Error(`${url}: reached only through the relay, and no https relay is configured`);
                return await clientFor(url, true)(request); // no straight way to it
            }
            if (relay && now() >= (relaySkip.get(url) ?? 0)) {
                try {
                    return await clientFor(url, true)(request);
                }
                catch (e) {
                    if (e instanceof Error && e.name === "AbortError")
                        throw e; // the caller cancelled
                    relaySkip.set(url, now() + failCacheMs); // the relay couldn't: straight, for a while
                }
            }
            return await clientFor(url, false)(request);
        }
        finally {
            release();
        }
    }
    const state = new Map(); // key: url + model
    const announced = new Map();
    function record(url, model, usable, detail) {
        state.set(`${url} ${model}`, { usable, until: now() + (usable ? okCacheMs : failCacheMs) });
        if (announced.get(url) !== usable) {
            announced.set(url, usable);
            opts.onStateChange?.(url, usable, detail);
        }
    }
    async function usable(url, model) {
        const cached = state.get(`${url} ${model}`);
        if (cached && now() < cached.until)
            return cached.usable;
        const { ok, detail } = await probe(url, model);
        record(url, model, ok, detail);
        return ok;
    }
    /** The first listed node that passes its checks and answers, or undefined. */
    async function tryNodes(urls, request) {
        for (const url of urls) {
            if (!(await usable(url, request.model)))
                continue;
            try {
                return { value: await send(url, request) };
            }
            catch (e) {
                record(url, request.model, false, `request failed: ${describeError(e)}`);
            }
        }
        return undefined;
    }
    /** The strongest direct node (ranking.ts) with a free slot that passes its checks and answers, or undefined
     *  (all full or failing). */
    async function tryDirect(request) {
        const tried = new Set();
        const order = ranked(direct, ranking(), slots);
        for (;;) {
            const url = order.find((u) => !tried.has(u) && leases.count(u) < (slots[u] ?? 1));
            if (url === undefined)
                return undefined;
            tried.add(url);
            // Take the slot now, before the (async) check: requests sent together must see each other.
            const release = leases.acquire(url);
            const req = asNode(url, request); // qwen3.8 under another tag on this one
            if (!(await usable(url, req.model))) {
                release();
                continue;
            }
            try {
                return { value: await send(url, req, release) };
            }
            catch (e) {
                if (e instanceof Error && e.name === "AbortError")
                    throw e; // the caller cancelled
                record(url, request.model, false, `request failed: ${describeError(e)}`);
            }
        }
    }
    let offHelpers = false; // a helper garbled a step of this run: the rest goes to the main model
    /** A small job on a helper with a free slot (biggest first) that passes its checks and answers, or undefined.
     *  `gated`: terminal work, handed back only if what it does only reads (helperReplyOk); the helpers with the best
     *  record for this kind of task first, none that keeps failing at it (experience.ts). */
    async function trySmall(request, gated = false) {
        for (const s of gated ? helperOrder(small, currentKind()) : small) {
            if (leases.count(s.url) >= (slots[s.url] ?? 1))
                continue;
            const release = leases.acquire(s.url);
            if (!(await usable(s.url, s.model))) {
                release();
                continue;
            }
            try {
                const value = await send(s.url, { ...request, model: s.model }, release);
                if (gated) {
                    const [ok, why, fault] = helperReplyOk(value?.message);
                    if (!ok) {
                        if (fault) {
                            offHelpers = true;
                            garbled(s.model, why);
                        }
                        return undefined; // a step for the main model
                    }
                    helped(s.model);
                }
                return { value };
            }
            catch (e) {
                if (e instanceof Error && e.name === "AbortError")
                    throw e; // the caller cancelled
                record(s.url, s.model, false, `request failed: ${describeError(e)}`);
            }
        }
        return undefined;
    }
    const visionProbe = opts.visionProbe ??
        ((url, model) => isRelayOnly(url)
            ? relay
                ? probeVision(relay.url, model, { token: relay.token, headers: { "X-Interdata-Node": relayName(url, relayNames) } })
                : Promise.resolve({ ok: false, detail: "reached only through the relay, and no https relay is configured" })
            : probeVision(url, model, { token: tokens[url] }));
    const unsure = new Map(); // url + model -> until when a server that couldn't tell is left alone
    /** Has this server shown it sees images? Asked once, then remembered for every ask on this machine (vision.ts).
     *  One that couldn't tell (out of memory for the picture, down) is asked again after failCacheMs. */
    async function sees(url, model) {
        const known = knownVision(url, model);
        if (known !== undefined)
            return known;
        if (now() < (unsure.get(`${url} ${model}`) ?? 0))
            return false;
        const { ok, detail } = await visionProbe(url, model);
        if (ok !== null)
            rememberVision(url, model, ok, detail);
        else
            unsure.set(`${url} ${model}`, now() + failCacheMs);
        return ok === true;
    }
    /** A request with images: the strongest node that sees them, free ones first (a busy one queues it). Never the hub
     *  or a smaller qwen: they may hand it to a server that drops the images and makes the picture up. */
    async function trySeeing(request) {
        const order = ranked([...new Set([...direct, ...nodes.lastResort])], ranking(), slots);
        const free = order.filter((u) => leases.count(u) < (slots[u] ?? 1));
        const why = [];
        for (const url of [...free, ...order.filter((u) => !free.includes(u))]) {
            const req = asNode(url, request);
            if (!(await sees(url, req.model))) {
                why.push(`${url} can't see images`);
                continue;
            }
            // A node busy with our own requests would fail the quick check; it takes this one after them.
            if (free.includes(url) && !(await usable(url, req.model))) {
                why.push(`${url} isn't answering`);
                continue;
            }
            try {
                return await send(url, req);
            }
            catch (e) {
                if (e instanceof Error && e.name === "AbortError")
                    throw e; // the caller cancelled
                record(url, request.model, false, `request failed: ${describeError(e)}`);
                why.push(`${url}: ${describeError(e)}`);
            }
        }
        throw new Error(`no ${request.model} server here can look at images right now (${why.join("; ") || "no servers configured or found"})`);
    }
    hub.chat = async (request) => {
        if (request?.stream || !request?.model)
            return rawHubChat(request);
        if (discovering) {
            await discovering;
            discovering = undefined;
        }
        const easy = request.model === HELPER_MODEL;
        const asked = request;
        request = forMain(request);
        if (hasImages(request))
            return trySeeing(request);
        const fromNode = await tryDirect(request);
        if (fromNode)
            return fromNode.value;
        const tools = Boolean(request.tools?.length);
        if (!tools || (easy && !offHelpers && estimateTokens(request) <= HELPER_MAX_TOKENS)) {
            const fromSmall = await trySmall(request, tools); // a small job or easy terminal work: a helper before the hub
            if (fromSmall)
                return fromSmall.value;
        }
        if (nodes.lastResort.length === 0)
            return hubWithRetries(asked);
        try {
            return await hubOnce(asked);
        }
        catch (e) {
            if (e instanceof Error && e.name === "AbortError")
                throw e; // the caller cancelled
            opts.retry?.onRetry?.(1, 1, describeError(e));
            const last = await tryNodes(nodes.lastResort, request);
            if (last)
                return last.value;
            return hubWithRetries(asked);
        }
    };
    return hub;
}
//# sourceMappingURL=nodes.js.map