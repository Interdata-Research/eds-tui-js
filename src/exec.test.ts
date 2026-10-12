import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCommand, runCommandOnce } from "./exec.js";
import { MAX_OUTPUT_CHARS } from "./clip.js";

const CWD = tmpdir();

test("returns trimmed stdout", async () => {
  const out = await runCommand("echo '  hello  '", CWD);
  assert.equal(out, "hello");
});

test("combines stdout and stderr, stdout first (matches Python's stdout + stderr concatenation)", async () => {
  const out = await runCommand("echo OUT; echo ERR 1>&2", CWD);
  assert.equal(out, "OUT\nERR");
});

test("empty output becomes the literal '(no output)' marker", async () => {
  const out = await runCommand("true", CWD);
  assert.equal(out, "(no output)");
});

test("a non-zero exit is NOT treated as an error — output is still returned plainly", async () => {
  const out = await runCommand("echo not-found-but-fine; exit 1", CWD);
  assert.equal(out, "not-found-but-fine");
});

test("a genuinely unresolvable shell error still returns something starting with 'Error:' territory via stderr, not a thrown exception", async () => {
  // A bogus command: the shell itself reports "command not found" on stderr
  // and exits 127 — this is NOT a catastrophic exec()-level failure, so it
  // must come back as plain (clipped) output, matching Python's behavior of
  // never checking the exit code.
  const out = await runCommand("this-command-does-not-exist-xyz", CWD);
  assert.match(out, /not found|not recognized/i);
});

test("timeout produces the fixed message, not partial output (matches the Python original exactly)", async () => {
  const out = await runCommand("echo partial-output; sleep 5", CWD, "  ", 200);
  assert.equal(out, "Error: command timed out after 30 seconds");
});

test("huge output is clipped through clipOutput", async () => {
  const out = await runCommand("node -e \"process.stdout.write('x'.repeat(500000))\"", CWD);
  assert.ok(out.length < MAX_OUTPUT_CHARS + 500);
  assert.match(out, /characters cut/);
});

test("runCommandOnce: an identical repeated command is replayed, not re-executed", async () => {
  const marker = join(tmpdir(), `eds-tui-exec-test-${Date.now()}-${Math.random()}`);
  rmSync(marker, { force: true });
  const seen = new Map<string, string>();

  const first = await runCommandOnce(`echo hit >> ${marker} && echo cache-probe`, CWD, seen);
  const second = await runCommandOnce(`echo hit >> ${marker} && echo cache-probe`, CWD, seen);

  assert.match(first, /cache-probe/);
  assert.match(second, /already ran earlier/);
  assert.equal(seen.size, 1);

  const hits = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean) : [];
  assert.equal(hits.length, 1, "the underlying command must only have actually executed once");
  rmSync(marker, { force: true });
});

test("runCommandOnce: different commands are not conflated", async () => {
  const seen = new Map<string, string>();
  const a = await runCommandOnce("echo A", CWD, seen);
  const b = await runCommandOnce("echo B", CWD, seen);
  assert.equal(a, "A");
  assert.equal(b, "B");
  assert.equal(seen.size, 2);
});

test("a timeout ends the command but not something it started in the background (how a dev server gets started)", async () => {
  const { execSync } = await import("node:child_process");
  const marker = `bgserver.${process.pid}`;
  const out = await runCommand(`bash -c 'exec -a "${marker}" sleep 30' & echo started`, tmpdir(), "  ", 500);
  assert.equal(out, "Error: command timed out after 30 seconds");
  const alive = execSync(`pgrep -f '^${marker}' || true`, { encoding: "utf8" }).trim();
  assert.notEqual(alive, "", "the background process is still running");
  execSync(`kill ${alive.split("\n").join(" ")}`);
});
