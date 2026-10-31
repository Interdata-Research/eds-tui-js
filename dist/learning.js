// Playbooks: the AI Command Center's notes on how a task was done the direct
// way, written from finished work into Edgar's local Eds LAN Brain
// ("unverified" until they've worked twice). ask gets them too when it runs
// outside the center (Edgar 2026-10-30: in his terminal, or a server's own
// ask): before answering a message, the playbooks that fit it go into the
// system prompt; after, a message that ran commands is reported (what was
// asked, what ran, the answer, the playbooks it got), and the center reviews it
// like a task's run: a new playbook, one counted again, or one that was wrong.
//
// The way to the center:
// - on its own machine, the "router" in ~/.eds_tui/nodes.json (its address and
//   login, already there for the model router): /api/v1/learning/*;
// - on another server, `ccd-node learning` (ccd-node 1.9+), which has that
//   server's token: ask never sees it.
// None when ask is one of the center's own tasks (CC_TASK_ID: the center does
// all of this itself), with EDS_TUI_LEARNING=0, or when neither is here.
// Everything fails soft and quickly: no center, no playbooks.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
export const SEARCH_TIMEOUT_MS = 4000;
export const REPORT_TIMEOUT_MS = 8000;
const NOTE_CHARS = 1600;
/** ccd-node on this machine: EDS_TUI_CCD_NODE, on PATH, or ~/.local/bin. */
export function findCcdNode(env = process.env) {
    if (env.EDS_TUI_CCD_NODE !== undefined)
        return env.EDS_TUI_CCD_NODE || undefined;
    const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin")];
    return dirs.map((d) => join(d, "ccd-node")).find((p) => existsSync(p));
}
/** The center's playbooks, or undefined (see the top of this file). */
export function learningSource(env, router, ccdNode = findCcdNode(env)) {
    if (env.CC_TASK_ID || env.EDS_TUI_LEARNING === "0")
        return undefined;
    if (router) {
        const base = router.url.replace(/\/+$/, "").replace(/\/llm$/, "") + "/api/v1/learning";
        const headers = { ...(router.token ? { Authorization: `Bearer ${router.token}` } : {}), "Content-Type": "application/json" };
        return {
            via: "center",
            async search(request, limit = 3) {
                const q = new URLSearchParams({ q: request.slice(0, 2000), limit: String(limit) });
                const r = await fetch(`${base}/playbooks?${q}`, { headers, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
                return r.ok ? (await r.json()).playbooks ?? [] : [];
            },
            async report(rep) {
                const r = await fetch(`${base}/runs`, {
                    method: "POST", headers, body: JSON.stringify(rep), signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
                });
                return r.ok && Boolean((await r.json()).reviewed);
            },
        };
    }
    if (ccdNode) {
        return {
            via: "ccd-node",
            async search(request, limit = 3) {
                const out = await runJson(ccdNode, ["learning", "search", request.slice(0, 2000), "--limit", String(limit)], "", SEARCH_TIMEOUT_MS);
                return out?.playbooks ?? [];
            },
            async report(rep) {
                const out = await runJson(ccdNode, ["learning", "run"], JSON.stringify(rep), REPORT_TIMEOUT_MS);
                return Boolean(out?.reviewed);
            },
        };
    }
    return undefined;
}
/** Run a command that prints one JSON object; undefined on any failure or timeout. */
function runJson(bin, args, input, timeoutMs) {
    return new Promise((resolve) => {
        let out = "";
        let done = false;
        const finish = (v) => {
            if (!done) {
                done = true;
                clearTimeout(timer);
                resolve(v);
            }
        };
        const child = spawn(bin, args, { stdio: ["pipe", "pipe", "ignore"] });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(undefined);
        }, timeoutMs);
        child.stdout.on("data", (d) => (out += d));
        child.on("error", () => finish(undefined));
        child.on("close", (code) => {
            try {
                finish(code === 0 ? JSON.parse(out) : undefined);
            }
            catch {
                finish(undefined);
            }
        });
        child.stdin.on("error", () => { }); // it may exit before reading
        child.stdin.end(input);
    });
}
/** The playbooks for the system prompt (as the center gives them to its agents). */
export function playbookNotes(books) {
    const notes = books.map((b) => {
        let steps = b.steps ?? "";
        if (steps.length > NOTE_CHARS)
            steps = steps.slice(0, NOTE_CHARS).replace(/\n[^\n]*$/, "") + "\n…";
        return `### ${b.title} (${b.status ?? "unverified"}, worked ${b.worked ?? 0}×) — ${b.path}\nWhen: ${b.when ?? ""}\n${steps}`;
    });
    return ('Playbooks from earlier tasks that may fit (Edgar\'s local brain; "verified" ones worked at least 2 times, ' +
        '"unverified" ones once: check one fits before you rely on it, and use a more direct way if you find one):\n\n' +
        notes.join("\n\n"));
}
const text = (c) => (typeof c === "string" ? c : JSON.stringify(c ?? ""));
/** What a message's work did, for the review: each command and the start of its output, cut to `max` characters. */
export function runLog(messages, from, max = 30000) {
    const lines = [];
    for (const m of messages.slice(from)) {
        if (m.role === "assistant") {
            for (const call of m.tool_calls ?? []) {
                const args = call.function?.arguments ?? {};
                lines.push(call.function?.name === "run_command" && typeof args.command === "string"
                    ? `> ${args.command}`
                    : `[${call.function?.name}] ${text(args).slice(0, 300)}`);
            }
        }
        else if (m.role === "tool") {
            const out = text(m.content);
            lines.push(...(out.length > 1500 ? out.slice(0, 1500) + "\n…" : out).split("\n").map((l) => `  ${l}`));
        }
    }
    const all = lines.join("\n");
    return all.length <= max ? all : all.slice(0, Math.floor(max / 4)) + "\n…\n" + all.slice(-Math.floor((max * 3) / 4));
}
//# sourceMappingURL=learning.js.map