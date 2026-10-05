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
// Configured with EDS_TUI_DIRECT_NODES (comma-separated URLs) or
// ~/.eds_tui/nodes.json ({"nodes": ["https://..."]}); env wins.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";
import { jsonErrors } from "./client.js";
import { describeError, withRetries } from "./retry.js";
export const NODES_FILE = join(homedir(), ".eds_tui", "nodes.json");
function clean(urls) {
    return urls
        .filter((u) => typeof u === "string")
        .map((u) => u.trim().replace(/\/+$/, ""))
        .filter((u) => /^https?:\/\//.test(u));
}
/** Direct node URLs from EDS_TUI_DIRECT_NODES, else ~/.eds_tui/nodes.json, else none. */
export function loadDirectNodes(env, path = NODES_FILE) {
    if (env.EDS_TUI_DIRECT_NODES !== undefined)
        return clean(env.EDS_TUI_DIRECT_NODES.split(","));
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        return Array.isArray(parsed?.nodes) ? clean(parsed.nodes) : [];
    }
    catch {
        return []; // missing or unreadable file: no direct nodes
    }
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
                headers: { "content-type": "application/json" },
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
/**
 * Wrap `client.chat` (the hub client, already wrapped by withRetries) so a
 * non-streaming request goes to the first direct node that passes its quick
 * checks, falling back to the hub. Returns the same client.
 */
export function withDirectNodes(hub, nodes, opts = {}) {
    if (nodes.length === 0)
        return hub;
    const probe = opts.probe ?? ((url, model) => probeNode(url, model));
    const okCacheMs = opts.okCacheMs ?? 20_000;
    const failCacheMs = opts.failCacheMs ?? 60_000;
    const now = opts.now ?? Date.now;
    const makeClient = opts.makeClient ?? ((url) => new Ollama({ host: url, fetch: jsonErrors(fetch) }));
    // Direct requests get the stream + malformed-tool-call handling, but no
    // same-node retries: any other failure falls back to the hub at once.
    const clients = new Map(nodes.map((url) => [url, withRetries(makeClient(url), { ...opts.retry, delaysMs: [0], retryTransient: false })]));
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
    const hubChat = hub.chat.bind(hub);
    hub.chat = async (request) => {
        if (request?.stream || !request?.model)
            return hubChat(request);
        for (const url of nodes) {
            if (!(await usable(url, request.model)))
                continue;
            try {
                return await clients.get(url).chat(request);
            }
            catch (e) {
                record(url, request.model, false, `request failed: ${describeError(e)}`);
            }
        }
        return hubChat(request);
    };
    return hub;
}
//# sourceMappingURL=nodes.js.map