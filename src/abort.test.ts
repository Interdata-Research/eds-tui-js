import { test } from "node:test";
import assert from "node:assert/strict";
import { Stopped, isStopped, raceStop, setRunSignal, stoppableChat, throwIfStopped } from "./abort.js";
import { runCommand } from "./exec.js";

test("raceStop: ends the wait as soon as the run is stopped; without a run it's the plain promise", async () => {
  setRunSignal(undefined);
  assert.equal(await raceStop(Promise.resolve(1)), 1);
  const c = new AbortController();
  setRunSignal(c.signal);
  const slow = new Promise((r) => setTimeout(() => r("late"), 2000));
  setTimeout(() => c.abort(), 20);
  const started = Date.now();
  await assert.rejects(raceStop(slow), (e) => isStopped(e));
  assert.ok(Date.now() - started < 1000);
  assert.throws(() => throwIfStopped(), Stopped);
  setRunSignal(undefined);
});

test("stoppableChat: a stopped run's model calls fail at once", async () => {
  const c = new AbortController();
  setRunSignal(c.signal);
  const client = stoppableChat({ chat: async (_req: unknown) => new Promise((r) => setTimeout(() => r({ message: {} }), 2000)) });
  setTimeout(() => c.abort(), 20);
  await assert.rejects(client.chat({}), (e) => isStopped(e));
  await assert.rejects(client.chat({}), (e) => isStopped(e), "and later ones don't even start");
  setRunSignal(undefined);
});

test("runCommand: stopping kills the command running", async () => {
  const c = new AbortController();
  setRunSignal(c.signal);
  setTimeout(() => c.abort(), 200);
  const started = Date.now();
  const marker = `sleep 20.${process.pid}`;
  await assert.rejects(runCommand(`bash -c 'exec -a "${marker}" sleep 20'; true`, process.cwd()), (e) => isStopped(e));
  assert.ok(Date.now() - started < 3000, "it doesn't wait for the command to finish");
  await new Promise((r) => setTimeout(r, 200));
  const { execSync } = await import("node:child_process");
  const left = execSync(`pgrep -f '^${marker}' || true`, { encoding: "utf8" }).trim();
  assert.equal(left, "", "and the command under the shell is gone too, not just the shell");
  setRunSignal(undefined);
});
