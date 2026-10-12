// Model servers whose streamed tool calls arrive broken: the RunPod-style
// servers (and the interdata hub when it routes to one) send only the last
// fragment of a call, `{"function":{"arguments":"}"}}`, while their
// non-streaming replies are complete. retry.ts used to find that out on
// every request — the whole reply generated twice, and a "Model request
// failed (malformed tool call…)" line each time. Now a server that does it
// once is remembered here (~/.eds_tui/stream-quirks.json, for a week, shared
// by every ask), and its tool requests are asked for whole replies from the
// start. Requests without tools still stream.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const QUIRKS_FILE = join(homedir(), ".eds_tui", "stream-quirks.json");
const REMEMBER_MS = 7 * 24 * 3600_000;

let file = QUIRKS_FILE;
let cache: Record<string, number> | null = null;

/** Tests: keep the list somewhere else (and forget what was loaded). */
export function useQuirksFile(path: string): void {
  file = path;
  cache = null;
}

function load(): Record<string, number> {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(file, "utf8")).brokenToolStreams ?? {};
  } catch {
    cache = {};
  }
  return cache!;
}

/** Does this server break streamed tool calls (seen in the last week)? */
export function breaksToolStreams(server: string | undefined, now = Date.now()): boolean {
  const seen = load()[server ?? ""];
  return seen !== undefined && now - seen < REMEMBER_MS;
}

export function rememberBrokenToolStreams(server: string | undefined, now = Date.now()): void {
  const list = load();
  list[server ?? ""] = now;
  if (!server) return; // an unnamed client: this process only
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ brokenToolStreams: list }, null, 2));
  } catch {
    // can't save it: this run still remembers
  }
}
