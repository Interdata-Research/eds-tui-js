// How many requests each qwen3.8 server is running right now, counted across
// every `ask` on this machine (several terminals, the AI Command Center's
// parallel tasks, and delegate_tasks' sub-agents inside one ask), so nodes.ts
// can send each request to the least busy server.
//
// One empty file per request in flight: ~/.eds_tui/inflight/<url hash>.<pid>.<n>.
// Counting is a readdir; files left by a process that died are ignored and
// removed. It's a soft limit: two processes counting at the same instant can
// both pick the same server, which only costs a little speed.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const INFLIGHT_DIR = join(homedir(), ".eds_tui", "inflight");
/** In this process only (tests, or when the directory can't be written). */
export function memoryLeases() {
    const counts = new Map();
    return {
        count: (url) => counts.get(url) ?? 0,
        acquire(url) {
            counts.set(url, (counts.get(url) ?? 0) + 1);
            let released = false;
            return () => {
                if (released)
                    return;
                released = true;
                counts.set(url, (counts.get(url) ?? 1) - 1);
            };
        },
    };
}
function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}
const key = (url) => createHash("sha1").update(url).digest("hex").slice(0, 12);
/** Shared with every ask on this machine through `dir`; falls back to this process's own counts. */
export function fileLeases(dir = INFLIGHT_DIR) {
    const local = memoryLeases();
    const mine = new Set();
    let seq = 0;
    let usable = true;
    process.once("exit", () => {
        for (const f of mine) {
            try {
                unlinkSync(f);
            }
            catch {
                // already gone
            }
        }
    });
    return {
        count(url) {
            if (!usable)
                return local.count(url);
            const prefix = `${key(url)}.`;
            let n = 0;
            try {
                for (const name of readdirSync(dir)) {
                    if (!name.startsWith(prefix))
                        continue;
                    const pid = Number(name.split(".")[1]);
                    if (pid === process.pid || alive(pid))
                        n++;
                    else {
                        try {
                            unlinkSync(join(dir, name));
                        }
                        catch {
                            // another ask cleaned it up first
                        }
                    }
                }
            }
            catch {
                return local.count(url);
            }
            return n;
        },
        acquire(url) {
            const releaseLocal = local.acquire(url);
            if (!usable)
                return releaseLocal;
            const file = join(dir, `${key(url)}.${process.pid}.${++seq}`);
            try {
                mkdirSync(dir, { recursive: true });
                writeFileSync(file, "");
                mine.add(file);
            }
            catch {
                usable = false;
                return releaseLocal;
            }
            return () => {
                releaseLocal();
                if (!mine.delete(file))
                    return;
                try {
                    unlinkSync(file);
                }
                catch {
                    // already gone
                }
            };
        },
    };
}
//# sourceMappingURL=leases.js.map