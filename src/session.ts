// The interactive session: `ask` in a terminal stays open like Claude Code.
// While a message is being worked on you can keep typing: Enter queues the
// next message, Esc stops the current one, ↑ on an empty line takes the last
// queued message back to edit. Queued messages run one after another in the
// same conversation. After Esc with messages still queued, the queue waits:
// Enter on an empty line runs them, Ctrl-C drops them, and a newly typed
// message goes first. Ctrl-D, Ctrl-C twice, or /exit leave.
//
// The AI Command Center (and anything else driving `ask` one message at a
// time) gets the one-shot behavior instead: see cli.ts's oneShot.

import chalk from "chalk";
import type { Message } from "ollama";
import { isStopped, setRunSignal } from "./abort.js";
import { LiveTerminal } from "./live.js";
import { describeError } from "./retry.js";
import * as ui from "./ui.js";

export interface SessionOptions {
  promptText: string;
  /** Answer one message; the conversation carries over to the next. Throws Stopped when Esc stops it. */
  run(text: string): Promise<void>;
  /** After a stop: make the conversation consistent again and save it. */
  stopped(): void;
}

const STOPPED_NOTE = "(Stopped by the user before finishing.)";

/**
 * After a stop the transcript can end mid-step: an assistant message whose
 * tool calls never got results (a model rejects that history), or the
 * user's message with no reply. Close it off so the conversation continues
 * cleanly and the model knows that request was cut short.
 */
export function repairAfterStop(messages: Message[]): void {
  let i = messages.length - 1;
  while (i >= 0 && messages[i]!.role === "tool") i--;
  const last = messages[i];
  if (last?.role === "assistant" && last.tool_calls?.length) {
    const answered = messages.length - 1 - i;
    for (let k = answered; k < last.tool_calls.length; k++) {
      messages.push({ role: "tool", content: "(not run: stopped by the user)" });
    }
  }
  if (messages[messages.length - 1]?.role !== "assistant") messages.push({ role: "assistant", content: STOPPED_NOTE });
}

export async function runSession(o: SessionOptions): Promise<void> {
  const queue: string[] = [];
  let controller: AbortController | null = null;
  let paused = false;
  let exiting = false;
  let wake: (() => void) | null = null;
  const poke = () => wake?.();

  const pausedNote = () =>
    `Stopped · ${queue.length} queued: Enter runs ${queue.length > 1 ? "them" : "it"} · ↑ edits the last · Ctrl-C drops ${queue.length > 1 ? "them" : "it"}`;

  const live = new LiveTerminal(o.promptText, {
    onSubmit(text) {
      const cmd = text.trim();
      if (cmd === "/exit" || cmd === "/quit") return exit();
      if (cmd === "/stop") return void controller?.abort();
      if (!cmd) {
        if (paused) {
          paused = false;
          live.flash("", 0);
          poke();
        }
        return;
      }
      if (paused) {
        queue.unshift(text); // something new goes first, then the rest
        paused = false;
        live.flash("", 0);
      } else queue.push(text);
      live.setQueue(controller || paused ? queue : []);
      poke();
    },
    onStop() {
      controller?.abort();
    },
    onExit: exit,
    onPullBack() {
      const text = queue.pop();
      if (paused && queue.length === 0) {
        paused = false;
        live.flash("", 0);
      } else if (paused) live.flash(pausedNote(), 24 * 3600_000);
      live.setQueue(controller || paused ? queue : []);
      return text;
    },
    onClearQueue() {
      if (!paused || queue.length === 0) return false;
      queue.length = 0;
      paused = false;
      live.setQueue([]);
      live.flash("Dropped the queued messages.");
      return true;
    },
  });

  function exit(): void {
    exiting = true;
    controller?.abort();
    poke();
  }

  ui.setStatusSink(live);
  live.start();
  try {
    while (!exiting) {
      if (queue.length === 0 || paused) {
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
        continue;
      }
      const text = queue.shift()!;
      live.setQueue(queue);
      live.print("\n" + o.promptText + text + "\n");
      controller = new AbortController();
      setRunSignal(controller.signal);
      live.setBusy(true);
      try {
        await o.run(text);
      } catch (e) {
        if (isStopped(e)) {
          console.log(chalk.yellow("  ⏹ Stopped."));
          console.log();
          o.stopped();
          if (queue.length && !exiting) {
            paused = true;
            live.flash(pausedNote(), 24 * 3600_000);
          }
        } else {
          console.log(chalk.red(`  Error: ${describeError(e)}`));
          console.log();
        }
      } finally {
        setRunSignal(undefined);
        controller = null;
        live.setBusy(false);
        live.setQueue(paused ? queue : []);
      }
    }
  } finally {
    live.stop();
    ui.setStatusSink(null);
  }
}
