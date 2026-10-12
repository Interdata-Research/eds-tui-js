// Ported from eds_tui/main.py's run_command()/run_command_once().
//
// Timeout/kill semantics: the Python original uses plain
// `subprocess.run(..., timeout=30)`, which kills only the shell, so a
// server a command started in the background keeps running after a
// timeout. That is kept on purpose (it's how a dev server gets started).
// Esc in the interactive session (abort.ts) is different: it kills the
// command's whole process group, which is why commands run in their own.
// On a timeout, the Python
// original's `except subprocess.TimeoutExpired` does NOT read
// `e.stdout`/`e.stderr` — it discards whatever partial output there was and
// returns the fixed message below. This port matches that exactly: no
// partial-output capture on timeout, by design, not by omission.
//
// Also: Python's subprocess.run never checks the exit code (no
// `check=True`), so a command that merely exits non-zero (grep finding
// nothing, `ls` on a missing path, ...) is NOT an "Error:" case — only a
// genuine timeout or a catastrophic failure-to-execute is.
import { spawn } from "node:child_process";
import { clipOutput } from "./clip.js";
import { Stopped, runSignal } from "./abort.js";
import { printCommand as printCommandLabel, printCommandOutput as printOutput, printCommandError as printError, printCachedNote, } from "./ui.js";
export const COMMAND_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export function runCommand(command, cwd, indent = "  ", timeoutMs = COMMAND_TIMEOUT_MS) {
    printCommandLabel(command, indent);
    const signal = runSignal();
    if (signal?.aborted)
        return Promise.reject(new Stopped());
    return new Promise((resolve, reject) => {
        // Its own process group, so Esc (abort.ts) ends the whole command, not just the shell
        // running it (a `sleep` under `sh -c` would otherwise outlive it). spawn, because exec
        // drops the `detached` option.
        const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        const out = [];
        const err = [];
        let size = 0;
        let ended = null;
        const killGroup = () => {
            try {
                if (child.pid)
                    process.kill(-child.pid, "SIGKILL");
            }
            catch {
                child.kill("SIGKILL"); // the group is already gone
            }
        };
        const end = (why) => {
            if (ended)
                return;
            ended = why;
            if (why === "stopped")
                killGroup();
            else
                child.kill(); // like exec: the shell only; something it started in the background lives on
            child.stdout.destroy(); // don't wait for a background process still holding the pipes
            child.stderr.destroy();
        };
        const collect = (into) => (b) => {
            size += b.length;
            if (size > MAX_BUFFER_BYTES)
                return end("overflow");
            into.push(b);
        };
        child.stdout.on("data", collect(out));
        child.stderr.on("data", collect(err));
        const timer = setTimeout(() => end("timeout"), timeoutMs);
        const onAbort = () => end("stopped");
        signal?.addEventListener("abort", onAbort, { once: true });
        const finish = (spawnError) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (ended === "stopped")
                return reject(new Stopped());
            if (ended === "timeout") {
                printError("command timed out after 30 seconds", indent);
                return resolve("Error: command timed out after 30 seconds");
            }
            if (spawnError || ended === "overflow") {
                // A catastrophic failure to even execute (the shell itself failing to
                // spawn, output past maxBuffer) — mirrors Python's generic
                // `except Exception as e: return f"Error: {e}"` fallback.
                const message = spawnError ? spawnError.message : "stdout maxBuffer length exceeded";
                printError(message, indent);
                return resolve(`Error: ${message}`);
            }
            // A mere non-zero exit is NOT an error here — Python's subprocess.run
            // never checks the exit code either.
            let output = Buffer.concat(out).toString("utf8") + Buffer.concat(err).toString("utf8");
            output = clipOutput(output.trim()) || "(no output)";
            printOutput(output, indent);
            resolve(output);
        };
        child.on("error", (e) => finish(e));
        child.on("close", () => finish());
    });
}
/**
 * Run a command, or replay it if this exact command already ran in this loop.
 *
 * A model that has not found what it is looking for tends to re-run
 * near-identical searches, and each repeat costs a round out of a hard
 * budget. Replaying the earlier output costs nothing and tells the model,
 * in the result it is about to read, that the repeat gave it nothing new.
 */
export async function runCommandOnce(command, cwd, seen, timeoutMs = COMMAND_TIMEOUT_MS) {
    const trimmed = (command ?? "").trim();
    if (seen.has(trimmed)) {
        printCachedNote(trimmed);
        return ("This exact command already ran earlier in this session and returned:\n" +
            `${seen.get(trimmed)}\n\n` +
            "It was not run again. Re-running it cannot tell you anything new — try a " +
            "materially different command, or answer from what you already have.");
    }
    const output = await runCommand(trimmed, cwd, "  ", timeoutMs);
    seen.set(trimmed, output);
    return output;
}
//# sourceMappingURL=exec.js.map