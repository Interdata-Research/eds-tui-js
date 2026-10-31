// How each helper model's terminal work ended, overall and per kind of task
// (task-kinds.ts), so ask's own routing (nodes.ts: the ladder) learns which
// helper is best at which kind of work.
//
// Edgar 2026-10-30: the dispatcher should learn from experience "which model
// is best at which kind of task". Each message ask answers is one run of its
// kind (beginTurn); the helpers that did a step of it are scored by how it
// ended (endTurn: answered = good; out of turns or failed = bad; stopped with
// Esc = not counted), and a garbled or empty helper reply counts against that
// helper at once. For easy terminal work the helper with the best record for
// that kind goes first (the fastest on a tie), and one that keeps failing —
// at least twice, and more than twice as often as not, overall or at that
// kind — gets no more of it until RETRY_MS after its last failure there.
// Kept in ~/.eds_tui/helper-experience.json, shared by every ask here.
//
// The same rules as the AI Command Center's router (app/llm_router.py, its
// data/llm_experience.json), which keeps the record when ask routes through it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { kindOf, OTHER } from "./task-kinds.js";
export const EXPERIENCE_FILE = join(homedir(), ".eds_tui", "helper-experience.json");
export const RETRY_MS = 6 * 3600_000;
let file = EXPERIENCE_FILE;
/** Tests: keep the record somewhere else. */
export function useExperienceFile(path) {
    file = path;
}
function load() {
    try {
        const data = JSON.parse(readFileSync(file, "utf8"));
        return data && typeof data === "object" ? data : {};
    }
    catch {
        return {};
    }
}
const badRecord = (t, now) => !!t && t.bad >= 2 && t.bad > 2 * t.good && now - (t.last_bad ?? 0) <= RETRY_MS;
/** May this helper model do terminal work (of this kind)? */
export function trusted(model, kind, now = Date.now()) {
    const e = load()[model];
    return !badRecord(e, now) && !(kind && badRecord(e?.kinds?.[kind], now));
}
/** How often its work of that kind ended well (smoothed: no record = 0.5). */
export function score(model, kind, records = load()) {
    const t = records[model]?.kinds?.[kind];
    return ((t?.good ?? 0) + 1) / ((t?.good ?? 0) + (t?.bad ?? 0) + 2);
}
/** Helpers for terminal work of this kind: trusted ones, the best record for it first (stable: speed order kept). */
export function helperOrder(small, kind, now = Date.now()) {
    const records = load();
    return small
        .filter((s) => trusted(s.model, kind, now))
        .map((s, i) => ({ s, i, sc: score(s.model, kind, records) }))
        .sort((a, b) => b.sc - a.sc || a.i - b.i)
        .map((x) => x.s);
}
/** Count one result for a helper model, overall and for its kind. Read fresh and written whole: several asks share it. */
export function learn(model, good, kind, why = "", now = Date.now()) {
    const records = load();
    const e = (records[model] ??= { good: 0, bad: 0 });
    const k = ((e.kinds ??= {})[kind] ??= { good: 0, bad: 0 });
    for (const t of [e, k]) {
        if (good)
            t.good += 1;
        else {
            t.bad += 1;
            t.last_bad = now;
        }
    }
    if (!good)
        e.last_why = why.slice(0, 200);
    try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(records, null, 1));
        renameSync(tmp, file);
    }
    catch {
        // can't save it: nothing learned this time
    }
}
// ---- the message being answered ----------------------------------------------------
let turn = { kind: OTHER, helpers: new Set() };
/** A new message to answer: its kind of work (returned), and no helpers yet. */
export function beginTurn(text) {
    turn = { kind: kindOf(text), helpers: new Set() };
    return turn.kind;
}
export const currentKind = () => turn.kind;
/** A helper did a step of this message's work. */
export function helped(model) {
    turn.helpers.add(model);
}
/** A helper's reply was garbled or empty: against it now, for this kind. */
export function garbled(model, why) {
    learn(model, false, turn.kind, why);
}
/** How the message ended: counts for (done) or against (unfinished, failed) the helpers that worked on it. */
export function endTurn(outcome) {
    const { helpers, kind } = turn;
    turn = { kind: OTHER, helpers: new Set() };
    if (outcome === "stopped")
        return; // Esc: nobody's fault
    for (const model of [...helpers].sort())
        learn(model, outcome === "done", kind, `a ${kind} message ${outcome}`);
}
//# sourceMappingURL=experience.js.map