// Ported from eds_tui/main.py's make_client()/_resolve_via_miniclosedai().
// Tries a local/LAN miniclosedai instance first — if it's reachable and
// connected to the interdata relay, uses that, preferring the desired
// main/small model names if interdata actually has them. On ANY failure
// (unreachable, not connected, empty model list, bad JSON, timeout, ...)
// falls back silently and without added latency to EDS_TUI_URL/EDS_TUI_TOKEN.
//
// Deliberately takes desiredMain/desiredSmall/env as parameters rather than
// reading process.env directly — the entry points decide when to apply
// env-derived names, and this module stays testable without mutating
// process.env. The env -> model-name *resolution* does live here, in
// desiredModels(), so that cli.ts and selftest.ts cannot drift apart on the
// precedence. They did drift: both hardcoded the defaults and neither ever
// read EDS_TUI_MODEL, despite the README documenting it and
// miniclosedai-node's installer writing it into two rc files.
import { Ollama } from "ollama";
import { Agent, fetch as undiciFetch } from "undici";
import { loadCredentials } from "./credentials.js";
export const DEFAULT_MAIN_MODEL = "qwen3.8:latest";
export const DEFAULT_MINICLOSEDAI_URL = "https://127.0.0.1:8095";
export const DEFAULT_HOST = "http://192.168.0.110:11434";
/** The main/small model names the caller *wants*: env first, package defaults
 *  otherwise. There is no separate default small model — unless
 *  EDS_TUI_SMALL_MODEL is set, the "small" role is just the main model, so
 *  every request runs on it. `.trim() ||` rather than `??` on purpose — an empty or
 *  whitespace-only value must fall back to the default rather than ask the
 *  relay for a model literally named "", which is what
 *  `printf 'export EDS_TUI_MODEL=%q' ""` in an installer would hand us. */
export function desiredModels(env) {
    const main = env.EDS_TUI_MODEL?.trim() || DEFAULT_MAIN_MODEL;
    return { main, small: env.EDS_TUI_SMALL_MODEL?.trim() || main };
}
// miniclosedai's dev.sh serves its own API over self-signed TLS by default
// (https://<host>:8095) — same trust model already used elsewhere for
// same-box/LAN sibling services in that project (e.g. its voicestudio proxy
// disables verification for the same reason). Only ever used for a same-box/
// LAN relay call, never for the actual interdata credential.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
const insecureFetch = ((input, init) => undiciFetch(input, { ...init, dispatcher: insecureAgent }));
function stripTrailingSlashes(url) {
    return url.replace(/\/+$/, "");
}
/**
 * Which main/small model names to actually use, given what a relay reports
 * as available. Prefers the desired names when the relay actually has them;
 * otherwise main falls back to whatever it does have, and small falls back
 * to main (never to some unrelated model the relay happens to list). Pulled out as a pure
 * function so this precedence is unit-testable without a live server.
 */
export function pickModels(names, desiredMain, desiredSmall) {
    if (names.length === 0) {
        throw new Error("miniclosedai relay reported no models");
    }
    const main = names.includes(desiredMain) ? desiredMain : names[0];
    const small = names.includes(desiredSmall) ? desiredSmall : main;
    return { main, small };
}
async function resolveViaMiniclosedai(desiredMain, desiredSmall, env) {
    const base = stripTrailingSlashes(env.EDS_TUI_MINICLOSEDAI_URL ?? DEFAULT_MINICLOSEDAI_URL);
    const mcToken = env.EDS_TUI_MINICLOSEDAI_TOKEN ?? "";
    const headers = mcToken ? { Authorization: `Bearer ${mcToken}` } : {};
    const res = await insecureFetch(`${base}/relay/api/tags`, {
        headers,
        signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
        throw new Error(`miniclosedai relay probe failed: HTTP ${res.status}`);
    }
    const data = (await res.json());
    const names = (data.models ?? [])
        .map((m) => m.name)
        .filter((n) => Boolean(n));
    const { main, small } = pickModels(names, desiredMain, desiredSmall);
    // No `timeout` field exists on ollama-js's Config (confirmed by reading
    // its source) — it applies no default request timeout unless the caller
    // passes an AbortSignal itself, which already matches Python's explicit
    // `timeout=None` (wait indefinitely for a long generation). Nothing to
    // configure here for parity.
    const client = new Ollama({ host: `${base}/relay/`, headers, fetch: insecureFetch });
    return { client, mainModel: main, smallModel: small };
}
// Precedence, most explicit first: EDS_TUI_URL/EDS_TUI_TOKEN env vars (an
// explicit override for this one invocation) beat a saved `ask --login`,
// which beats the hardcoded default — same "flag > saved config > default"
// shape used elsewhere (e.g. resolve-model.ts's own precedence). A env var
// set without its pair (e.g. EDS_TUI_URL set but no EDS_TUI_TOKEN) still
// wins over the saved login entirely, matching the principle that an
// explicit env var always means "use exactly this, don't guess further" —
// picking a saved token to pair with an explicitly-set URL would connect
// to a host the user didn't ask that credential to be used with.
// credentialsPath is injectable (defaults to the real CREDENTIALS_FILE)
// purely for testing — matches the same pattern skills.ts/model-pool.ts
// already use for their own paths.
export function fallbackClient(desiredMain, desiredSmall, env, credentialsPath) {
    let host;
    let token;
    if (env.EDS_TUI_URL || env.EDS_TUI_TOKEN) {
        host = stripTrailingSlashes(env.EDS_TUI_URL ?? DEFAULT_HOST);
        token = env.EDS_TUI_TOKEN ?? "";
    }
    else {
        const saved = loadCredentials(credentialsPath);
        host = stripTrailingSlashes(saved?.hubUrl ?? DEFAULT_HOST);
        token = saved?.token ?? "";
    }
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const client = new Ollama({ host, headers });
    return { client, mainModel: desiredMain, smallModel: desiredSmall };
}
export async function makeClient(desiredMain = DEFAULT_MAIN_MODEL, desiredSmall = desiredMain, env = process.env) {
    try {
        return await resolveViaMiniclosedai(desiredMain, desiredSmall, env);
    }
    catch {
        // miniclosedai not reachable, or not connected to interdata — fall back,
        // silently, matching the Python original's bare `except Exception: pass`.
        return fallbackClient(desiredMain, desiredSmall, env);
    }
}
//# sourceMappingURL=client.js.map