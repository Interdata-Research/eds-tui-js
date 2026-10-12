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
/** http://<ip>:11434 for every online Tailscale peer; none if tailscale isn't there. */
export function tailscalePeers(timeoutMs = 2_000) {
    return new Promise((resolve) => {
        execFile("tailscale", ["status", "--json"], { timeout: timeoutMs }, (err, stdout) => {
            if (err)
                return resolve([]);
            try {
                const peers = Object.values((JSON.parse(stdout).Peer ?? {}));
                resolve(peers
                    .filter((p) => p?.Online && Array.isArray(p.TailscaleIPs))
                    .map((p) => p.TailscaleIPs.find((ip) => ip.includes(".")))
                    .filter((ip) => Boolean(ip))
                    .map((ip) => `http://${ip}:${OLLAMA_PORT}`));
            }
            catch {
                resolve([]);
            }
        });
    });
}
async function tags(url, o) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 1_500);
    try {
        const token = o.tokens?.[url];
        const res = await (o.fetchFn ?? fetch)(`${url}/api/tags`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
        });
        return res.ok ? (await res.json()) : null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Same disk, same pull times: the same server. */
export function fingerprint(t) {
    const models = (t.models ?? []).map((m) => `${m.name}|${m.digest}|${m.modified_at}`).sort();
    return createHash("sha1").update(models.join("\n")).digest("hex");
}
export async function discoverNodes(o) {
    const found = await (o.candidates ?? (() => tailscalePeers()))();
    const configured = new Set(o.configured);
    const urls = [...o.configured, ...found.filter((u) => !configured.has(u))];
    const replies = await Promise.all(urls.map((u) => tags(u, o)));
    const owner = new Map(); // fingerprint -> the address that keeps it
    const out = { urls: [], duplicates: {} };
    urls.forEach((url, i) => {
        const t = replies[i];
        if (!t || !(t.models ?? []).length)
            return;
        const fp = fingerprint(t);
        const first = owner.get(fp);
        if (first) {
            out.duplicates[url] = first;
            return;
        }
        owner.set(fp, url);
        if (!configured.has(url) && (t.models ?? []).some((m) => m.name === o.model))
            out.urls.push(url);
    });
    return out;
}
/** discoverNodes(), through the cache file (fresh for DISCOVERY_MAX_AGE_MS, same model and configuration). */
export async function discoverCached(o) {
    const path = o.path ?? DISCOVERED_FILE;
    const now = (o.now ?? Date.now)();
    try {
        const c = JSON.parse(readFileSync(path, "utf8"));
        if (now - c.at < (o.maxAgeMs ?? DISCOVERY_MAX_AGE_MS) &&
            c.model === o.model &&
            JSON.stringify(c.configured) === JSON.stringify(o.configured)) {
            return { urls: c.urls, duplicates: c.duplicates ?? {} };
        }
    }
    catch {
        // no cache yet, or unreadable: look now
    }
    const d = await discoverNodes(o);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ at: now, model: o.model, configured: o.configured, ...d }, null, 2));
    }
    catch {
        // can't cache: the next run looks again
    }
    return d;
}
//# sourceMappingURL=discover.js.map