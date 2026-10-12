// The input line of the interactive session (live.ts): the same editing as
// input.ts's promptLine (arrows, word moves, Home/End, Delete, backspace,
// bracketed paste collapsed to [+N lines]), but as a state machine fed raw
// terminal bytes and returning events, because it stays active while a run
// prints above it. promptLine itself is left as it is: the one-shot mode the
// AI Command Center drives depends on its exact behavior.
//
// A bare Esc is ambiguous on the byte stream (it also starts every arrow
// key's sequence), so a lone trailing ESC is held as `pending`; the caller
// calls flushEscape() after a short pause, and only then is it a real Esc.
import { PASTE_END, PASTE_START, classifyPaste, parseEscape, spliceBackPastes, wordLeft, wordRight, } from "./input.js";
export class LineEditor {
    buf = "";
    cursor = 0;
    pasted = [];
    inPaste = false;
    pasteAccum = "";
    /** A possibly-incomplete escape sequence held over to the next chunk. */
    pending = "";
    set(text) {
        this.buf = text;
        this.cursor = text.length;
        this.pasted = [];
    }
    clear() {
        this.set("");
    }
    insert(text) {
        this.buf = this.buf.slice(0, this.cursor) + text + this.buf.slice(this.cursor);
        this.cursor += text.length;
    }
    /** A lone ESC that nothing followed: the Esc key itself. */
    flushEscape() {
        if (this.pending !== "\x1b")
            return [];
        this.pending = "";
        return [{ type: "escape" }];
    }
    feed(chunk) {
        const str = this.pending + chunk;
        this.pending = "";
        const events = [];
        let changed = false;
        let i = 0;
        while (i < str.length) {
            const rest = str.slice(i);
            if (this.inPaste) {
                const end = rest.indexOf(PASTE_END);
                if (end === -1) {
                    this.pasteAccum += rest;
                    break;
                }
                this.pasteAccum += rest.slice(0, end);
                const result = classifyPaste(this.pasteAccum);
                if (result.placeholder)
                    this.pasted.push(this.pasteAccum);
                this.insert(result.insertText);
                this.pasteAccum = "";
                this.inPaste = false;
                changed = true;
                i += end + PASTE_END.length;
                continue;
            }
            if (rest.startsWith(PASTE_START)) {
                this.inPaste = true;
                i += PASTE_START.length;
                continue;
            }
            if (rest[0] === "\x1b" && PASTE_START.startsWith(rest)) {
                this.pending = rest; // maybe the start of a paste marker, or a lone Esc
                break;
            }
            const ch = rest[0];
            if (ch === "\x03") {
                events.push({ type: "interrupt" });
                i += 1;
                continue;
            }
            if (ch === "\x04") {
                if (this.buf.length === 0)
                    events.push({ type: "eof" });
                i += 1;
                continue;
            }
            if (ch === "\r" || ch === "\n") {
                const text = spliceBackPastes(this.buf, this.pasted);
                this.clear();
                changed = true;
                events.push({ type: "submit", text }); // empty too: it resumes a paused queue (session.ts)
                i += 1;
                continue;
            }
            if (ch === "\x7f" || ch === "\x08") {
                if (this.cursor > 0) {
                    this.buf = this.buf.slice(0, this.cursor - 1) + this.buf.slice(this.cursor);
                    this.cursor -= 1;
                    changed = true;
                }
                i += 1;
                continue;
            }
            if (ch === "\x15") {
                // Ctrl-U: clear the line
                this.clear();
                changed = true;
                i += 1;
                continue;
            }
            if (ch === "\x1b") {
                const parsed = parseEscape(rest);
                if (parsed === "incomplete") {
                    this.pending = rest;
                    break;
                }
                if (parsed.key === null && parsed.length === 1) {
                    events.push({ type: "escape" }); // Esc, then another key right after it
                }
                switch (parsed.key) {
                    case "left":
                        if (this.cursor > 0)
                            this.cursor -= 1;
                        break;
                    case "right":
                        if (this.cursor < this.buf.length)
                            this.cursor += 1;
                        break;
                    case "wordLeft":
                        this.cursor = wordLeft(this.buf, this.cursor);
                        break;
                    case "wordRight":
                        this.cursor = wordRight(this.buf, this.cursor);
                        break;
                    case "home":
                        this.cursor = 0;
                        break;
                    case "end":
                        this.cursor = this.buf.length;
                        break;
                    case "delete":
                        if (this.cursor < this.buf.length)
                            this.buf = this.buf.slice(0, this.cursor) + this.buf.slice(this.cursor + 1);
                        break;
                    case "up":
                        if (this.buf.length === 0)
                            events.push({ type: "up" });
                        break;
                }
                if (parsed.key)
                    changed = true;
                i += parsed.length;
                continue;
            }
            if (ch >= " " || ch === "\t") {
                this.insert(ch === "\t" ? " " : ch);
                changed = true;
            }
            i += 1;
        }
        if (changed)
            events.push({ type: "changed" });
        return events;
    }
}
//# sourceMappingURL=line-editor.js.map