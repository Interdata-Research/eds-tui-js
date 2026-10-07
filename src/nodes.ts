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
// an entry is a URL string, or {"url": "...", "token": "..."} for a node
// behind a proxy that wants `Authorization: Bearer <token>`. A URL may
// carry a path (a proxy that serves a node under a prefix).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Ollama } from "ollama";
import { jsonErrors } from "./client.js";
import { describeError, withRetries, type RetryOptions } from "./retry.js";

export const NODES_FILE = join(homedir(), ".eds_tui", "nodes.json");

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}

/** URLs from a list of strings or {url, token} objects; tokens collected into `tokens`. */
function clean(entries: unknown[], tokens: Record<string, string>): string[] {
  const urls: string[] = [];
  for (const entry of entries) {
    const url = typeof entry === "string" ? entry : (entry as { url?: unknown } | null)?.url;
    if (typeof url !== "string" || !/^https?:\/\//.test(url.trim())) continue;
    const normalized = normalizeUrl(url);
    const token = (entry as { token?: unknown } | null)?.token;
    if (typeof token === "string" && token.trim()) tokens[normalized] = token.trim();
    urls.push(normalized);
  }
  return urls;
}

export interface NodeConfig {
  /** Tried first, before the hub. */
  direct: string[];
  /** Tried only after the hub's first attempt fails. */
  lastResort: string[];
  /** Bearer tokens for nodes that need one, by URL. */
  tokens?: Record<string, string>;
}

function authHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Node lists from EDS_TUI_DIRECT_NODES / EDS_TUI_LAST_RESORT_NODES, else ~/.eds_tui/nodes.json, else none. */
export function loadNodeConfig(env: NodeJS.ProcessEnv, path: string = NODES_FILE): NodeConfig {
  let file: { nodes?: unknown; lastResort?: unknown } = {};
  try {
    file = JSON.parse(readFileSync(path, "utf8")) ?? {};
  } catch {
    // missing or unreadable file: no nodes from it
  }
  const tokens: Record<string, string> = {};
  const pick = (envValue: string | undefined, fileValue: unknown): string[] =>
    envValue !== undefined ? clean(envValue.split(","), tokens) : Array.isArray(fileValue) ? clean(fileValue, tokens) : [];
  return {
    direct: pick(env.EDS_TUI_DIRECT_NODES, file.nodes),
    lastResort: pick(env.EDS_TUI_LAST_RESORT_NODES, file.lastResort),
    tokens,
  };
}

export interface ProbeOptions {
  /** How many quick checks must all pass. */
  attempts?: number;
  /** Deadline for each check. */
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Sent as `Authorization: Bearer <token>`, for a node behind an authenticating proxy. */
  token?: string;
}

/**
 * Can this node generate right now? Asks for a one-token reply `attempts`
 * times; every one must come back done within `timeoutMs`. Stops at the
 * first failure.
 */
export async function probeNode(url: string, model: string, opts: ProbeOptions = {}): Promise<{ ok: boolean; detail: string }> {
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
        headers: { "content-type": "application/json", ...authHeaders(opts.token) },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "hi" }],
          stream: false,
          think: false,
          options: { num_predict: 1 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, detail: `check ${i}: HTTP ${res.status}` };
      const body = (await res.json().catch(() => null)) as { done?: boolean } | null;
      if (!body?.done) return { ok: false, detail: `check ${i}: no reply` };
    } catch (e) {
      return { ok: false, detail: controller.signal.aborted ? `check ${i}: no reply within ${timeoutMs / 1000}s` : `check ${i}: ${describeError(e)}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: true, detail: `${attempts} quick checks passed` };
}

export interface NodeRoutingOptions {
  probe?: (url: string, model: string) => Promise<{ ok: boolean; detail: string }>;
  /** Build the client for a direct or last-resort node. */
  makeClient?: (url: string) => Ollama;
  /** How long a passed check is trusted before checking again. */
  okCacheMs?: number;
  /** How long a failed node is skipped before checking it again. */
  failCacheMs?: number;
  /** Told whenever a node's state changes (usable / skipped), for diagnostics. */
  onStateChange?: (url: string, usable: boolean, detail: string) => void;
  now?: () => number;
  /** Retry behavior for the hub (and the stream handling every route gets). */
  retry?: RetryOptions;
}

type Chat = (req: any) => Promise<any>;

/**
 * Wrap the hub client's `chat` with the routing above. Takes the plain hub
 * client (this applies withRetries itself) and returns the same client.
 */
export function withNodeRouting(hub: Ollama, nodes: NodeConfig, opts: NodeRoutingOptions = {}): Ollama {
  const rawHubChat = hub.chat.bind(hub) as Chat;
  const hubWithRetries = withRetries({ chat: rawHubChat } as unknown as Ollama, opts.retry).chat as Chat;
  if (nodes.direct.length === 0 && nodes.lastResort.length === 0) {
    (hub as any).chat = hubWithRetries;
    return hub;
  }
  // One hub attempt (still re-asking a malformed reply), then on to the last resort.
  const hubOnce = withRetries({ chat: rawHubChat } as unknown as Ollama, { ...opts.retry, delaysMs: [0], retryTransient: false }).chat as Chat;

  const tokens = nodes.tokens ?? {};
  const probe = opts.probe ?? ((url, model) => probeNode(url, model, { token: tokens[url] }));
  const okCacheMs = opts.okCacheMs ?? 20_000;
  const failCacheMs = opts.failCacheMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const makeClient =
    opts.makeClient ?? ((url: string) => new Ollama({ host: url, headers: authHeaders(tokens[url]), fetch: jsonErrors(fetch) }));

  // Node requests get the stream + malformed-tool-call handling, but no
  // same-node retries: any other failure moves on to the next route at once.
  const clients = new Map<string, Chat>();
  for (const url of [...nodes.direct, ...nodes.lastResort]) {
    if (!clients.has(url)) clients.set(url, withRetries(makeClient(url), { ...opts.retry, delaysMs: [0], retryTransient: false, onRetry: undefined }).chat as Chat);
  }
  const state = new Map<string, { usable: boolean; until: number }>(); // key: url + model
  const announced = new Map<string, boolean>();

  function record(url: string, model: string, usable: boolean, detail: string): void {
    state.set(`${url} ${model}`, { usable, until: now() + (usable ? okCacheMs : failCacheMs) });
    if (announced.get(url) !== usable) {
      announced.set(url, usable);
      opts.onStateChange?.(url, usable, detail);
    }
  }

  async function usable(url: string, model: string): Promise<boolean> {
    const cached = state.get(`${url} ${model}`);
    if (cached && now() < cached.until) return cached.usable;
    const { ok, detail } = await probe(url, model);
    record(url, model, ok, detail);
    return ok;
  }

  /** The first listed node that passes its checks and answers, or undefined. */
  async function tryNodes(urls: string[], request: any): Promise<{ value: any } | undefined> {
    for (const url of urls) {
      if (!(await usable(url, request.model))) continue;
      try {
        return { value: await clients.get(url)!(request) };
      } catch (e) {
        record(url, request.model, false, `request failed: ${describeError(e)}`);
      }
    }
    return undefined;
  }

  (hub as any).chat = async (request: any) => {
    if (request?.stream || !request?.model) return rawHubChat(request);

    const direct = await tryNodes(nodes.direct, request);
    if (direct) return direct.value;
    if (nodes.lastResort.length === 0) return hubWithRetries(request);

    try {
      return await hubOnce(request);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw e; // the caller cancelled
      opts.retry?.onRetry?.(1, 1, describeError(e));
      const last = await tryNodes(nodes.lastResort, request);
      if (last) return last.value;
      return hubWithRetries(request);
    }
  };
  return hub;
}
