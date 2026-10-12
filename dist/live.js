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
import { LineEditor } from "./line-editor.js";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ESC_DELAY_MS = 40;
/** Plain text cut to fit `width` columns (input without ANSI codes). */
export function fit(text, width) {
    const flat = text.replace(/\s+/g, " ");
    if (stringWidth(flat) <= width)
        return flat;
    let out = "";
    for (const ch of flat) {
        if (stringWidth(out + ch + "…") > width)
            break;
        out += ch;
    }
    return out + "…";
}
/**
 * The footer's lines above the input, and where things land in the input
 * line (which can wrap): the row the cursor is on and the row the text ends
 * on, counted from the input's first row, and the cursor's column.
 */
export function layout(s) {
    const lines = [];
    const width = Math.max(10, s.cols - 1);
    if (s.status !== null)
        lines.push(s.status);
    for (const q of s.queued.slice(0, 3))
        lines.push(chalk.dim(`  ↳ queued: ${fit(q, width - 12)}`));
    if (s.queued.length > 3)
        lines.push(chalk.dim(`  ↳ …and ${s.queued.length - 3} more`));
    if (s.note)
        lines.push(chalk.dim(`  ${fit(s.note, width - 2)}`));
    const promptWidth = stringWidth(s.promptText);
    const cursorCol = promptWidth + stringWidth(s.buf.slice(0, s.cursor));
    const endCol = promptWidth + stringWidth(s.buf);
    const cols = Math.max(1, s.cols);
    const endRow = endCol === 0 ? 0 : Math.floor((endCol - 1) / cols);
    const cursorRow = Math.floor(cursorCol / cols);
    return { lines, inputRow: lines.length, cursorRow, endRow, col: cursorCol % cols };
}
export class LiveTerminal {
    promptText;
    handlers;
    editor = new LineEditor();
    origOut = process.stdout.write.bind(process.stdout);
    origErr = process.stderr.write.bind(process.stderr);
    shown = false;
    rowsAbove = 0; // rows between the footer's first row and the cursor
    partial = false; // the last output didn't end its line
    partialTimer;
    spin;
    escTimer;
    frame = 0;
    busySince = null;
    statuses = [];
    nextId = 1;
    queued = [];
    note = null;
    noteTimer;
    onData = (chunk) => this.handle(this.editor.feed(chunk.toString("utf8")));
    constructor(promptText, handlers) {
        this.promptText = promptText;
        this.handlers = handlers;
    }
    start() {
        const stdin = process.stdin;
        if (stdin.isTTY)
            stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", this.onData);
        this.origOut("\x1b[?2004h");
        process.stdout.write = (chunk, ...rest) => this.through(this.origOut, chunk, rest);
        process.stderr.write = (chunk, ...rest) => this.through(this.origErr, chunk, rest);
        process.stdout.on("resize", this.redraw);
        process.once("exit", () => this.stop());
        this.draw();
    }
    stop() {
        if (!this.origOut)
            return;
        clearInterval(this.spin);
        clearTimeout(this.partialTimer);
        clearTimeout(this.escTimer);
        clearTimeout(this.noteTimer);
        this.erase();
        process.stdout.write = this.origOut;
        process.stderr.write = this.origErr;
        process.stdout.off("resize", this.redraw);
        process.stdin.off("data", this.onData);
        this.origOut("\x1b[?2004l");
        if (process.stdin.isTTY)
            process.stdin.setRawMode(false);
        process.stdin.pause();
        this.origOut = undefined;
    }
    /** A run started (spinner on) or ended (null). */
    setBusy(busy) {
        this.busySince = busy ? Date.now() : null;
        this.statuses = [];
        clearInterval(this.spin);
        if (busy)
            this.spin = setInterval(() => (this.frame++, this.redraw()), 100);
        this.redraw();
    }
    setQueue(items) {
        this.queued = [...items];
        this.redraw();
    }
    /** A short note above the input (e.g. "press Ctrl-C again to exit"), gone after `ms`; "" removes it. */
    flash(text, ms = 2500) {
        this.note = text || null;
        clearTimeout(this.noteTimer);
        if (this.note)
            this.noteTimer = setTimeout(() => ((this.note = null), this.redraw()), ms);
        this.redraw();
    }
    /** ui.withSpinner's text while it runs; returns the function that removes it. */
    pushStatus(text) {
        const id = this.nextId++;
        this.statuses.push({ id, text });
        this.redraw();
        return () => {
            this.statuses = this.statuses.filter((s) => s.id !== id);
            this.redraw();
        };
    }
    /** Write straight to the terminal above the footer (e.g. echoing a message as it starts). */
    print(text) {
        process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    }
    statusLine() {
        if (this.busySince === null)
            return null;
        const text = this.statuses.length ? this.statuses[this.statuses.length - 1].text : "Working...";
        const secs = Math.floor((Date.now() - this.busySince) / 1000);
        const hint = `  (${secs}s · esc to stop${this.queued.length ? " · ↑ edit queued" : " · type to queue"})`;
        const width = Math.max(10, (process.stdout.columns || 80) - 1);
        const plain = fit(text.replace(/\x1b\[[0-9;]*m/g, "").trim(), Math.max(5, width - 2 - stringWidth(hint)));
        return chalk.cyan(FRAMES[this.frame % FRAMES.length]) + " " + chalk.italic.dim(plain) + chalk.dim(hint);
    }
    through(write, chunk, rest) {
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
        if (!this.partial)
            this.draw();
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
    erase() {
        if (!this.shown)
            return;
        this.origOut("\r" + (this.rowsAbove > 0 ? `\x1b[${this.rowsAbove}A` : "") + "\x1b[J");
        this.shown = false;
    }
    draw() {
        if (this.shown || this.partial || !this.origOut)
            return;
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
        if (endRow > l.cursorRow)
            out += `\x1b[${endRow - l.cursorRow}A`;
        out += "\r" + (l.col > 0 ? `\x1b[${l.col}C` : "");
        this.origOut(out);
        this.rowsAbove = l.inputRow + l.cursorRow;
        this.shown = true;
    }
    redraw = () => {
        if (this.partial || !this.origOut)
            return;
        this.erase();
        this.draw();
    };
    handle(events) {
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
                    if (this.busySince !== null)
                        this.handlers.onStop();
                    break;
                case "interrupt":
                    if (this.editor.buf) {
                        this.editor.clear();
                        this.handlers.onEdit?.();
                    }
                    else if (this.busySince !== null)
                        this.handlers.onStop();
                    else if (!this.handlers.onClearQueue())
                        this.handlers.onExit();
                    break;
                case "eof":
                    this.handlers.onExit();
                    break;
                case "up": {
                    const text = this.handlers.onPullBack();
                    if (text !== undefined)
                        this.editor.set(text);
                    break;
                }
            }
        }
        if (events.some((e) => e.type === "changed"))
            this.handlers.onEdit?.();
        this.redraw();
    }
}
//# sourceMappingURL=live.js.map