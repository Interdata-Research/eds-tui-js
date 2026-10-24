// Which qwen3.8 server is the strongest: measured, the same way the AI Command
// Center ranks them (ai_command_center app/llm_router.py), so a new server that
// answers faster takes the lead by itself instead of waiting for someone to
// reorder nodes.json.
//
// Every server answers the same benchmark: a ~2.5k-token prompt (reading it
// counts, as it does for an agentic turn) with a random start (so no server
// answers from a prompt cache), and BENCH_REPLY tokens back. `est` is how many
// seconds that took. It goes the way real work goes (through the relay pinned
// to that server when it can, else straight), in one of the server's slots,
// only while the server runs nothing of ours, and again after BENCH_EVERY_MS.
// The results are shared by every ask on this machine in ~/.eds_tui/ranking.json.
//
// A server's strength is what it answers with every slot busy: slots / (est ×
// (1 + BATCH_SLOWDOWN × (slots − 1))) requests a second. A batching server
// (RunPod) slows each request by about 0.6 per extra one (measured: 8.4 s
// alone, 18.5 s each for 3 at once). nodes.ts sends each request to the
// strongest server with a free slot. Measured 2026-10-24 through the relay:
// RunPod 5.5 s × 4 slots = 0.26/s, the spark 4.8 s × 1 = 0.21/s, vps-3 17 s =
// 0.06/s: Edgar's order (the spark is a bit faster alone, but takes one request
// at a time). Servers not measured yet rank after the measured ones, in their
// configured order.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Leases } from "./leases.js";

export const RANKING_FILE = join(homedir(), ".eds_tui", "ranking.json");
export const BENCH_EVERY_MS = 30 * 60_000;
export const BENCH_REPLY = 64;
export const BENCH_TIMEOUT_MS = 180_000;
export const BATCH_SLOWDOWN = 0.6;
const BENCH_TEXT = "The command center routes each request to the server expected to answer it first. ".repeat(120);

export interface Measured {
  /** Seconds for the benchmark. */
  est: number;
  /** When (ms since the epoch). */
  at: number;
}
export type Ranking = Record<string, Measured>;

export function readRanking(path: string = RANKING_FILE): Ranking {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" ? (data as Ranking) : {};
  } catch {
    return {};
  }
}

/** Merge `update` into the file (atomically: other asks read it at the same time). */
export function writeRanking(update: Ranking, path: string = RANKING_FILE): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...readRanking(path), ...update }, null, 1));
    renameSync(tmp, path);
  } catch {
    // not saved: measured again next time
  }
}

/** Requests a second a server answers with every slot busy; 0 when never measured. */
export function strength(m: Measured | undefined, slots = 1): number {
  return m && m.est > 0 ? slots / (m.est * (1 + BATCH_SLOWDOWN * (slots - 1))) : 0;
}

/** The servers strongest first: measured ones by strength (faster on a tie), then the others in list order. */
export function ranked(urls: string[], ranking: Ranking, slots: Record<string, number> = {}): string[] {
  const key = (u: string) => strength(ranking[u], slots[u] ?? 1);
  return urls
    .map((u, i) => ({ u, i, m: ranking[u] }))
    .sort((a, b) => Number(!a.m) - Number(!b.m) || key(b.u) - key(a.u) || (a.m?.est ?? 0) - (b.m?.est ?? 0) || a.i - b.i)
    .map((x) => x.u);
}

/** Where a request to a server can be sent: the relay pinned to it, then straight (nodes.ts routesFor). */
export interface Route {
  url: string;
  headers: Record<string, string>;
}

/** Seconds the benchmark took on the first route that answers it, or null (every route failed). */
export async function benchmark(
  routes: Route[],
  model: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = BENCH_TIMEOUT_MS
): Promise<number | null> {
  const body = JSON.stringify({
    model,
    stream: false,
    think: false,
    options: { num_predict: BENCH_REPLY, temperature: 0 },
    messages: [{ role: "user", content: `[${randomBytes(8).toString("hex")}] ${BENCH_TEXT}\nNow count from 1 to 200, separated by spaces.` }],
  });
  for (const route of routes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetchFn(`${route.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...route.headers },
        body,
        signal: controller.signal,
      });
      const reply = (await res.json().catch(() => null)) as { message?: unknown; error?: unknown } | null;
      if (res.ok && reply?.message && !reply.error) return (Date.now() - started) / 1000;
    } catch {
      // this route failed: the next one
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export interface RefreshOptions {
  urls: string[];
  model: string;
  /** A server's own name for the model (qwen3.8 under another tag). */
  modelFor?: (url: string) => string | undefined;
  routesFor: (url: string) => Route[];
  leases: Leases;
  path?: string;
  now?: () => number;
  everyMs?: number;
  fetchFn?: typeof fetch;
  /** Measure even a fresh one (`ask --nodes`). */
  force?: boolean;
}

/** Benchmark the servers whose measurement is stale and that run nothing of ours right now, one after another. */
export async function refreshRanking(o: RefreshOptions): Promise<Ranking> {
  const now = o.now ?? Date.now;
  const path = o.path ?? RANKING_FILE;
  for (const url of o.urls) {
    const last = readRanking(path)[url];
    if (!o.force && last && now() - last.at < (o.everyMs ?? BENCH_EVERY_MS)) continue;
    if (o.leases.count(url) > 0) continue; // busy with real work: next time
    const release = o.leases.acquire(url);
    try {
      const est = await benchmark(o.routesFor(url), o.modelFor?.(url) ?? o.model, o.fetchFn);
      if (est !== null) writeRanking({ [url]: { est, at: now() } }, path);
    } finally {
      release();
    }
  }
  return readRanking(path);
}
