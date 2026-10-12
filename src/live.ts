// The interactive session's terminal (session.ts): output scrolls as usual,
// and below it a footer stays put, like Claude Code's:
//
//   ⠹ Thinking...  (12s · esc to stop)
//     ↳ queued: and then add a test for it
//    proj ❯ what I'm typing now
//
// Every write to stdout/stderr first erases the footer, then the footer is
// drawn again under the new output, so nothing anywhere else has to know
// about it: console.log, marked, boxen and runCommand's output all just
// print. Spinners (ui.withSpinner) set the footer's status line instead of
// starting ora. Raw mode keeps the terminal's \n -> \r\n translation
// (libuv's raw mode leaves ONLCR on), so output isn't staircased.

import chalk from "chalk";
import stringWidth from "string-width";
import { LineEditor, type EditorEvent } from "./line-editor.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ESC_DELAY_MS = 40;

export interface FooterState {
  promptText: string;
  buf: string;
  cursor: number;
  /** null when idle (no status line). */
  status: string | null;
  queued: string[];
  note: string | null;
  cols: number;
}

/** Plain text cut to fit `width` columns (input without ANSI codes). */
export function fit(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ");
  if (stringWidth(flat) <= width) return flat;
  let out = "";
  for (const ch of flat) {
    if (stringWidth(out + ch + "…") > width) break;
    out += ch;
  }
  return out + "…";
}

/**
 * The footer's lines above the input, and where things land in the input
 * line (which can wrap): the row the cursor is on and the row the text ends
 * on, counted from the input's first row, and the cursor's column.
 */
export function layout(s: FooterState): { lines: string[]; inputRow: number; cursorRow: number; endRow: number; col: number } {
  const lines: string[] = [];
  const width = Math.max(10, s.cols - 1);
  if (s.status !== null) lines.push(s.status);
  for (const q of s.queued.slice(0, 3)) lines.push(chalk.dim(`  ↳ queued: ${fit(q, width - 12)}`));
  if (s.queued.length > 3) lines.push(chalk.dim(`  ↳ …and ${s.queued.length - 3} more`));
  if (s.note) lines.push(chalk.dim(`  ${fit(s.note, width - 2)}`));
  const promptWidth = stringWidth(s.promptText);
  const cursorCol = promptWidth + stringWidth(s.buf.slice(0, s.cursor));
  const endCol = promptWidth + stringWidth(s.buf);
  const cols = Math.max(1, s.cols);
  const endRow = endCol === 0 ? 0 : Math.floor((endCol - 1) / cols);
  const cursorRow = Math.floor(cursorCol / cols);
  return { lines, inputRow: lines.length, cursorRow, endRow, col: cursorCol % cols };
}

export interface LiveHandlers {
  onSubmit(text: string): void;
  onStop(): void;
  onExit(): void;
  /** ↑ on an empty line: the last queued message, taken back out of the queue to edit. */
  onPullBack(): string | undefined;
  /** Ctrl-C on an empty line while idle: true if it dropped waiting messages (instead of offering to exit). */
  onClearQueue(): boolean;
}

export class LiveTerminal {
  readonly editor = new LineEditor();
  private origOut = process.stdout.write.bind(process.stdout);
  private origErr = process.stderr.write.bind(process.stderr);
  private shown = false;
  private rowsAbove = 0; // rows between the footer's first row and the cursor
  private partial = false; // the last output didn't end its line
  private partialTimer: NodeJS.Timeout | undefined;
  private spin: NodeJS.Timeout | undefined;
  private escTimer: NodeJS.Timeout | undefined;
  private frame = 0;
  private busySince: number | null = null;
  private statuses: Array<{ id: number; text: string }> = [];
  private nextId = 1;
  private queued: string[] = [];
  private note: string | null = null;
  private noteTimer: NodeJS.Timeout | undefined;
  private lastInterrupt = 0;
  private onData = (chunk: Buffer) => this.handle(this.editor.feed(chunk.toString("utf8")));

  constructor(
    private promptText: string,
    private handlers: LiveHandlers
  ) {}

  start(): void {
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", this.onData);
    this.origOut("\x1b[?2004h");
    (process.stdout as any).write = (chunk: any, ...rest: any[]) => this.through(this.origOut, chunk, rest);
    (process.stderr as any).write = (chunk: any, ...rest: any[]) => this.through(this.origErr, chunk, rest);
    process.stdout.on("resize", this.redraw);
    process.once("exit", () => this.stop());
    this.draw();
  }

  stop(): void {
    if (!this.origOut) return;
    clearInterval(this.spin);
    clearTimeout(this.partialTimer);
    clearTimeout(this.escTimer);
    clearTimeout(this.noteTimer);
    this.erase();
    (process.stdout as any).write = this.origOut;
    (process.stderr as any).write = this.origErr;
    process.stdout.off("resize", this.redraw);
    process.stdin.off("data", this.onData);
    this.origOut("\x1b[?2004l");
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.origOut = undefined as any;
  }

  /** A run started (spinner on) or ended (null). */
  setBusy(busy: boolean): void {
    this.busySince = busy ? Date.now() : null;
    this.statuses = [];
    clearInterval(this.spin);
    if (busy) this.spin = setInterval(() => (this.frame++, this.redraw()), 100);
    this.redraw();
  }

  setQueue(items: string[]): void {
    this.queued = [...items];
    this.redraw();
  }

  /** A short note above the input (e.g. "press Ctrl-C again to exit"), gone after `ms`; "" removes it. */
  flash(text: string, ms = 2500): void {
    this.note = text || null;
    clearTimeout(this.noteTimer);
    if (this.note) this.noteTimer = setTimeout(() => ((this.note = null), this.redraw()), ms);
    this.redraw();
  }

  /** ui.withSpinner's text while it runs; returns the function that removes it. */
  pushStatus(text: string): () => void {
    const id = this.nextId++;
    this.statuses.push({ id, text });
    this.redraw();
    return () => {
      this.statuses = this.statuses.filter((s) => s.id !== id);
      this.redraw();
    };
  }

  /** Write straight to the terminal above the footer (e.g. echoing a message as it starts). */
  print(text: string): void {
    process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  }

  private statusLine(): string | null {
    if (this.busySince === null) return null;
    const text = this.statuses.length ? this.statuses[this.statuses.length - 1]!.text : "Working...";
    const secs = Math.floor((Date.now() - this.busySince) / 1000);
    const hint = `  (${secs}s · esc to stop${this.queued.length ? " · ↑ edit queued" : " · type to queue"})`;
    const width = Math.max(10, (process.stdout.columns || 80) - 1);
    const plain = fit(text.replace(/\x1b\[[0-9;]*m/g, "").trim(), Math.max(5, width - 2 - stringWidth(hint)));
    return chalk.cyan(FRAMES[this.frame % FRAMES.length]) + " " + chalk.italic.dim(plain) + chalk.dim(hint);
  }

  private through(write: (...a: any[]) => boolean, chunk: any, rest: any[]): boolean {
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
      this.partialTimer = undefined;
    }
    this.erase();
    const result = write(chunk, ...rest);
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (text.length === 0) {
      this.draw();
      return result;
    }
    this.partial = !text.endsWith("\n");
    if (!this.partial) this.draw();
    else {
      // A line still being written: give it a moment to finish before the footer comes back under it.
      this.partialTimer = setTimeout(() => {
        this.partialTimer = undefined;
        this.origOut("\n");
        this.partial = false;
        this.draw();
      }, 150);
    }
    return result;
  }

  private erase(): void {
    if (!this.shown) return;
    this.origOut("\r" + (this.rowsAbove > 0 ? `\x1b[${this.rowsAbove}A` : "") + "\x1b[J");
    this.shown = false;
  }

  private draw(): void {
    if (this.shown || this.partial || !this.origOut) return;
    const l = layout({
      promptText: this.promptText,
      buf: this.editor.buf,
      cursor: this.editor.cursor,
      status: this.statusLine(),
      queued: this.queued,
      note: this.note,
      cols: process.stdout.columns || 80,
    });
    let out = l.lines.map((line) => line + "\n").join("") + this.promptText + this.editor.buf;
    let endRow = l.endRow;
    if (l.cursorRow > endRow) {
      out += " \b"; // the cursor sits just past a full row: start the next one
      endRow = l.cursorRow;
    }
    if (endRow > l.cursorRow) out += `\x1b[${endRow - l.cursorRow}A`;
    out += "\r" + (l.col > 0 ? `\x1b[${l.col}C` : "");
    this.origOut(out);
    this.rowsAbove = l.inputRow + l.cursorRow;
    this.shown = true;
  }

  private redraw = (): void => {
    if (this.partial || !this.origOut) return;
    this.erase();
    this.draw();
  };

  private handle(events: EditorEvent[]): void {
    clearTimeout(this.escTimer);
    if (this.editor.pending === "\x1b") {
      this.escTimer = setTimeout(() => this.handle(this.editor.flushEscape()), ESC_DELAY_MS);
    }
    for (const e of events) {
      switch (e.type) {
        case "submit":
          this.handlers.onSubmit(e.text);
          break;
        case "escape":
          if (this.busySince !== null) this.handlers.onStop();
          break;
        case "interrupt":
          if (this.editor.buf) this.editor.clear();
          else if (this.busySince !== null) this.handlers.onStop();
          else if (this.handlers.onClearQueue()) break;
          else if (Date.now() - this.lastInterrupt < 2000) this.handlers.onExit();
          else {
            this.lastInterrupt = Date.now();
            this.flash("Press Ctrl-C again to exit (or Ctrl-D).");
          }
          break;
        case "eof":
          this.handlers.onExit();
          break;
        case "up": {
          const text = this.handlers.onPullBack();
          if (text !== undefined) this.editor.set(text);
          break;
        }
      }
    }
    this.redraw();
  }
}
