// Finding the network's qwen3.8 servers by itself, so `ask` can spread
// parallel work over all of them without anyone listing them first.
//
// Candidates are the online Tailscale peers (`tailscale status --json`),
// each tried at http://<peer>:11434. A peer counts when its /api/tags lists
// the model. One server is often reachable under two addresses (a RunPod
// pod answers both at its proxy URL and at its Tailscale IP), and using both
// would send it twice its share. So every server is fingerprinted by its
// model list, including each model's modified_at, which is the moment it
// was pulled on that disk: two addresses with the same fingerprint are one
// server, and the configured address wins.
//
// A found peer is used only with a model it already has LOADED (/api/ps): it is
// never made to load one (Edgar's laptop has qwen3.8:27b, unloaded: loading it
// would take the laptop over). Such peers are listed as `idle`. The main model
// under another tag of its family (qwen3.8:27b for qwen3.8:latest, same
// weights) counts as the main model, sent under that tag (`models`).
//
// Helpers: any other chat model loaded on peers WITHOUT the main model
// (qwen3.5 9B/4B, the Raspberry Pi's lfm2.5, gemma, phi…: Edgar 2026-10-30,
// every local model powerful enough to lend a hand, not only qwens) is kept
// too, for small jobs when every qwen3.8 server is full (nodes.ts): never on a
// qwen3.8 server (a second model on its GPU), never cloud, embedding or one-job
// fine-tunes, never under SMALL_MIN_B billion parameters
// (EDS_TUI_SMALL_MIN_B, 3: the 1-2B ones aren't worth a job); the biggest
// loaded one.
//
// The result is cached in ~/.eds_tui/discovered.json for 10 minutes, so most
// runs don't look at all. Off with EDS_TUI_DISCOVER=0, `"discover": false`
// in nodes.json, or an explicit EDS_TUI_DIRECT_NODES (an exact list: that's
// how the AI Command Center routes its tasks through its own router).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DISCOVERED_FILE = join(homedir(), ".eds_tui", "discovered.json");
export const DISCOVERY_MAX_AGE_MS = 10 * 60_000;
const OLLAMA_PORT = 11434;

export interface SmallServer {
  url: string;
  /** The model it takes small jobs with (requests are sent under this name). */
  model: string;
  /** Its size in billions of parameters (bigger first). */
  params: number;
}

export interface Discovered {
  /** Servers to add to the direct nodes, in the order found. */
  urls: string[];
  /** Addresses left out because they are a configured (or earlier) server under another address. */
  duplicates: Record<string, string>;
  /** Helper models on servers without the main model, biggest first. */
  small: SmallServer[];
  /** Found servers that have the main model under another tag (qwen3.8:27b): the name to send. */
  models?: Record<string, string>;
  /** Found servers with the main model NOT loaded: listed, never used. */
  idle?: Array<{ url: string; model: string }>;
}

export interface DiscoverOptions {
  model: string;
  /** Configured servers (direct and last resort): never added twice, and they win a fingerprint tie. */
  configured: string[];
  tokens?: Record<string, string>;
  fetchFn?: typeof fetch;
  /** Ollama URLs to try; default: the online Tailscale peers. */
  candidates?: () => Promise<string[]>;
  timeoutMs?: number;
}

/** http://<ip>:11434 for every online Tailscale peer; none if tailscale isn't there. */
export function tailscalePeers(timeoutMs = 2_000): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("tailscale", ["status", "--json"], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve([]);
      try {
        const peers = Object.values((JSON.parse(stdout).Peer ?? {}) as Record<string, any>);
        resolve(
          peers
            .filter((p) => p?.Online && Array.isArray(p.TailscaleIPs))
            .map((p) => (p.TailscaleIPs as string[]).find((ip) => ip.includes(".")))
            .filter((ip): ip is string => Boolean(ip))
            .map((ip) => `http://${ip}:${OLLAMA_PORT}`)
        );
      } catch {
        resolve([]);
      }
    });
  });
}

interface Tags {
  models?: Array<{
    name?: string;
    digest?: string;
    modified_at?: string;
    details?: { parameter_size?: string; family?: string; families?: string[] };
  }>;
}

async function tags(url: string, o: DiscoverOptions, path = "tags"): Promise<Tags | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 1_500);
  try {
    const token = o.tokens?.[url];
    const res = await (o.fetchFn ?? fetch)(`${url}/api/${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    return res.ok ? ((await res.json()) as Tags) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Same disk, same pull times: the same server. */
export function fingerprint(t: Tags): string {
  const models = (t.models ?? []).map((m) => `${m.name}|${m.digest}|${m.modified_at}`).sort();
  return createHash("sha1").update(models.join("\n")).digest("hex");
}

/** "4.7B" -> 4.7, "137M" -> 0.137: a model's details.parameter_size in billions; 0 when unknown. */
export function paramsB(size: string | undefined): number {
  const m = /^\s*([\d.]+)\s*([BMT])/i.exec(size ?? "");
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  return unit === "M" ? n / 1000 : unit === "T" ? n * 1000 : n;
}

const NOT_SMALL = /cloud|embed|rerank|bge|minilm|rasa|judge|base/i;
const NOT_CHAT_FAMILY = /bert|clip/i; // embedding / vision encoders
export const SMALL_MIN_B = Number(process.env.EDS_TUI_SMALL_MIN_B ?? 3) || 0;

const base = (name: string) => name.split(":")[0]!;

/** The main model on a server under any tag of its family (qwen3.8:latest, qwen3.8:27b…), the exact name first. */
export function familyModel(t: Tags, mainModel: string): string | null {
  const names = (t.models ?? []).map((m) => m.name ?? "");
  if (names.includes(mainModel)) return mainModel;
  return names.find((n) => n && base(n) === base(mainModel) && !NOT_SMALL.test(n)) ?? null;
}

/** The helper a server without the main model takes small jobs with: its biggest LOADED chat model of at
 *  least `minB` billion parameters, any family. */
export function smallModel(
  t: Tags,
  loaded: Set<string>,
  mainModel: string,
  minB = SMALL_MIN_B
): { model: string; params: number } | null {
  const chat = (d: { family?: string; families?: string[] } = {}) => !NOT_CHAT_FAMILY.test([d.family ?? "", ...(d.families ?? [])].join(" "));
  const helpers = (t.models ?? []).filter(
    (m) =>
      m.name &&
      !NOT_SMALL.test(m.name) &&
      chat(m.details) &&
      base(m.name) !== base(mainModel) &&
      loaded.has(m.name) &&
      paramsB(m.details?.parameter_size) >= minB
  );
  if (!helpers.length) return null;
  const best = helpers.reduce((a, b) => (paramsB(b.details?.parameter_size) > paramsB(a.details?.parameter_size) ? b : a));
  return { model: best.name!, params: paramsB(best.details?.parameter_size) };
}

export async function discoverNodes(o: DiscoverOptions): Promise<Discovered> {
  const found = await (o.candidates ?? (() => tailscalePeers()))();
  const configured = new Set(o.configured);
  const urls = [...o.configured, ...found.filter((u) => !configured.has(u))];
  const replies = await Promise.all(urls.map((u) => tags(u, o)));
  const owner = new Map<string, string>(); // fingerprint -> the address that keeps it
  const out: Discovered = { urls: [], duplicates: {}, small: [], models: {}, idle: [] };
  const others: Array<[string, Tags]> = []; // found peers: the main model loaded, else maybe a helper
  urls.forEach((url, i) => {
    const t = replies[i];
    if (!t || !(t.models ?? []).length) return;
    const fp = fingerprint(t);
    const first = owner.get(fp);
    if (first) {
      out.duplicates[url] = first;
      return;
    }
    owner.set(fp, url);
    if (configured.has(url)) return;
    others.push([url, t]);
  });
  const ps = await Promise.all(others.map(([url]) => tags(url, o, "ps")));
  others.forEach(([url, t], i) => {
    const loaded = new Set((ps[i]?.models ?? []).map((m) => m.name!).filter(Boolean));
    const fam = familyModel(t, o.model);
    if (fam && loaded.has(fam)) {
      out.urls.push(url);
      if (fam !== o.model) out.models![url] = fam;
    } else if (fam) {
      out.idle!.push({ url, model: fam }); // never made to load it
    } else {
      const pick = smallModel(t, loaded, o.model);
      if (pick) out.small.push({ url, ...pick });
    }
  });
  out.small.sort((a, b) => b.params - a.params);
  return out;
}

interface Cache extends Discovered {
  at: number;
  model: string;
  configured: string[];
}

/** discoverNodes(), through the cache file (fresh for DISCOVERY_MAX_AGE_MS, same model and configuration). */
export async function discoverCached(
  o: DiscoverOptions & { path?: string; now?: () => number; maxAgeMs?: number }
): Promise<Discovered> {
  const path = o.path ?? DISCOVERED_FILE;
  const now = (o.now ?? Date.now)();
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as Cache;
    if (
      now - c.at < (o.maxAgeMs ?? DISCOVERY_MAX_AGE_MS) &&
      c.model === o.model &&
      JSON.stringify(c.configured) === JSON.stringify(o.configured)
    ) {
      return { urls: c.urls, duplicates: c.duplicates ?? {}, small: c.small ?? [], models: c.models ?? {}, idle: c.idle ?? [] };
    }
  } catch {
    // no cache yet, or unreadable: look now
  }
  const d = await discoverNodes(o);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ at: now, model: o.model, configured: o.configured, ...d }, null, 2));
  } catch {
    // can't cache: the next run looks again
  }
  return d;
}
