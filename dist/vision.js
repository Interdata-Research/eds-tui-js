// Seeing images. qwen3.8 is a vision model, but `ask` never sent it a
// picture: asked to look at wallpapers, it shelled out to `ollama run
// gemma3:4b` instead. Now:
//   - view_image (tools.ts) loads an image file into the conversation, and
//     image paths typed in a message are attached to it (cli.ts);
//   - an image is shrunk to IMAGE_MAX_SIDE first (ImageMagick or ffmpeg,
//     whichever the machine has), since every later request resends it;
//   - only the last MAX_IMAGES_KEPT images stay attached (keepRecentImages);
//   - a request carrying images goes only to a server that has shown it
//     really sees them (nodes.ts). A server can say "vision" in /api/show and
//     still drop every image: the RunPod pod is llama.cpp behind an Ollama
//     shim, started without its vision projector, and it answered "describe
//     this picture" by inventing one. probeVision() shows the server a
//     two-color picture and checks it names both colors; the verdict is kept
//     in ~/.eds_tui/vision.json (a day for "can't see", a week for "sees").
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { describeError } from "./retry.js";
import { printViewImage } from "./ui.js";
export const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tif", "tiff", "heic", "avif"];
/** Longest side an image is sent at: plenty for the model, and small enough to resend every turn. */
export const IMAGE_MAX_SIDE = 1280;
/** Images left attached to the conversation; older ones are replaced by a note (view_image brings one back). */
export const MAX_IMAGES_KEPT = 6;
/** Images a typed message attaches by itself; more are left for view_image. */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** What may be sent as-is when nothing on this machine can shrink it. */
const RAW_MAX_BYTES = 8 * 1024 * 1024;
const RAW_OK = new Set(["jpg", "jpeg", "png"]);
const IMAGE_RE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join("|")})$`, "i");
function expand(path, cwd) {
    const p = path.trim();
    if (p === "~")
        return homedir();
    if (p.startsWith("~/"))
        return join(homedir(), p.slice(2));
    return isAbsolute(p) ? p : resolve(cwd, p);
}
function size(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function run(cmd, args) {
    return new Promise((done) => {
        execFile(cmd, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => done(err || !stdout?.length ? null : stdout));
    });
}
/** The image as a JPEG no bigger than IMAGE_MAX_SIDE, from ImageMagick or ffmpeg; null when neither can. */
async function shrink(path) {
    const box = `${IMAGE_MAX_SIDE}x${IMAGE_MAX_SIDE}>`;
    for (const magick of ["magick", "convert"]) {
        const out = await run(magick, [`${path}[0]`, "-auto-orient", "-resize", box, "-quality", "85", "jpg:-"]);
        if (out)
            return out;
    }
    const fit = `scale='min(${IMAGE_MAX_SIDE},iw)':'min(${IMAGE_MAX_SIDE},ih)':force_original_aspect_ratio=decrease`;
    return run("ffmpeg", ["-v", "error", "-i", path, "-frames:v", "1", "-vf", fit, "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "-"]);
}
/** Read an image file for the model. Throws a plain-words Error when it can't. */
export async function loadImage(path, cwd) {
    const full = expand(path, cwd);
    let bytes;
    try {
        const st = statSync(full);
        if (st.isDirectory())
            throw new Error(`${full} is a folder, not an image (list it with run_command, then view one file)`);
        bytes = st.size;
    }
    catch (e) {
        if (e.code === "ENOENT")
            throw new Error(`no such file: ${full}`);
        throw e;
    }
    const ext = /\.([a-z0-9]+)$/i.exec(full)?.[1]?.toLowerCase() ?? "";
    const small = await shrink(full);
    if (small) {
        const note = small.length < bytes && size(small.length) !== size(bytes) ? `shrunk from ${size(bytes)} to ${size(small.length)}` : size(small.length);
        return { path: full, data: small.toString("base64"), note };
    }
    if (!RAW_OK.has(ext)) {
        throw new Error(`can't read a .${ext || "?"} image here without ImageMagick or ffmpeg (only JPEG and PNG as they are)`);
    }
    if (bytes > RAW_MAX_BYTES) {
        throw new Error(`${full} is ${size(bytes)}, too big to send as it is, and there is no ImageMagick or ffmpeg here to shrink it`);
    }
    return { path: full, data: readFileSync(full).toString("base64"), note: size(bytes) };
}
/**
 * Image files a message names: words ending in an image extension (quoted
 * ones may hold spaces, and a backslash-escaped space counts) that exist,
 * relative to cwd or with ~. At most MAX_IMAGES_PER_MESSAGE.
 */
export function findImagePaths(text, cwd) {
    const words = [];
    for (const m of text.matchAll(/"([^"]+)"|'([^']+)'|`([^`]+)`|((?:\\ |\S)+)/g)) {
        words.push((m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").replace(/\\ /g, " ").replace(/[),.;:!?]+$/, "").replace(/^\(/, ""));
    }
    const found = [];
    for (const w of words) {
        if (!IMAGE_RE.test(w))
            continue;
        const full = expand(w, cwd);
        try {
            if (!found.includes(full) && existsSync(full) && statSync(full).isFile())
                found.push(full);
        }
        catch {
            // unreadable: not attached
        }
        if (found.length >= MAX_IMAGES_PER_MESSAGE)
            break;
    }
    return found;
}
export function hasImages(request) {
    return Boolean(request?.messages?.some((m) => (m.images?.length ?? 0) > 0));
}
const DROPPED = "\n(An image was attached here earlier; it was dropped to keep the conversation small. Call view_image again to see it.)";
/** A message's text for when its images are left out (an older message, or one saved to history): it says one was there. */
export function withoutImages(m) {
    const content = String(m.content ?? "");
    return (m.images?.length ?? 0) > 0 && !content.includes(DROPPED) ? content + DROPPED : content;
}
/** Said at the end of a typed message that named image files, so the model knows they are already attached. */
export function attachedNote(paths) {
    return `\n\n[Attached to this message for you to see, in order: ${paths.join(", ")}. No need to call view_image for them.]`;
}
/** Keep only the newest `keep` images attached; older messages lose theirs and say so. */
export function keepRecentImages(messages, keep = MAX_IMAGES_KEPT) {
    let left = keep;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const n = m.images?.length ?? 0;
        if (!n)
            continue;
        if (left >= n) {
            left -= n;
            continue;
        }
        m.content = withoutImages(m);
        m.images = left > 0 ? m.images.slice(n - left) : undefined;
        if (!m.images)
            delete m.images;
        left = 0;
    }
}
/** The message that carries the images view_image loaded this round (a tool result can't carry them everywhere). */
export function viewedImagesMessage(images) {
    const list = images.map((i) => i.path).join(", ");
    return {
        role: "user",
        content: `[view_image] ${images.length === 1 ? "The image" : `The ${images.length} images`} you asked to see, in order: ${list}. ` +
            "(Attached by the view_image tool, not typed by the user.)",
        images: images.map((i) => i.data),
    };
}
/**
 * Run one view_image tool call: the tool result for the model, and the image
 * to attach after this round's results (viewedImagesMessage), if it loaded.
 */
export async function viewImage(path, cwd, indent = "  ") {
    const p = typeof path === "string" ? path.trim() : "";
    if (!p)
        return { output: "view_image needs a path to an image file." };
    try {
        const image = await loadImage(p, cwd);
        printViewImage(image.path, { note: image.note }, indent);
        return { output: `Loaded ${image.path} (${image.note}). It is attached in the next message, for you to look at.`, image };
    }
    catch (e) {
        const message = describeError(e);
        printViewImage(p, { error: message }, indent);
        return { output: `view_image failed: ${message}` };
    }
}
// ---- does a server really see? ------------------------------------------------
const COLORS = [
    ["red", [220, 20, 20]],
    ["green", [20, 170, 40]],
    ["blue", [20, 50, 220]],
    ["yellow", [245, 220, 20]],
    ["black", [0, 0, 0]],
    ["white", [255, 255, 255]],
];
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf)
        c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
/** A PNG, `w`×`h`, its left half one color and its right half another. */
export function twoColorPng(left, right, w = 128, h = 64) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(w, 0);
    header.writeUInt32BE(h, 4);
    header[8] = 8; // bit depth
    header[9] = 2; // RGB
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++)
        row.set(x < w / 2 ? left : right, 1 + x * 3);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}
/**
 * Does this server see images? It's shown a picture with two colored halves
 * and must name both colors (a guess gets both right 1 time in 15). A model
 * without "vision" in /api/show is blind without asking. `ok: null` when it
 * couldn't tell (the server failed, timed out): ask again next time.
 */
export async function probeVision(url, model, opts = {}) {
    const fetchFn = opts.fetchFn ?? fetch;
    const headers = {
        "content-type": "application/json",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
    };
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const show = await fetchFn(`${url}/api/show`, {
            method: "POST", headers, body: JSON.stringify({ model }), signal: controller.signal,
        }).catch(() => null);
        const caps = show?.ok ? (await show.json().catch(() => null))?.capabilities : undefined;
        if (Array.isArray(caps) && !caps.includes("vision"))
            return { ok: false, detail: `${model} there is not a vision model` };
        const [a, b] = opts.pick?.() ?? (() => {
            const i = Math.floor(Math.random() * COLORS.length);
            return [i, (i + 1 + Math.floor(Math.random() * (COLORS.length - 1))) % COLORS.length];
        })();
        const [left, right] = [COLORS[a], COLORS[b]];
        const res = await fetchFn(`${url}/api/chat`, {
            method: "POST",
            headers,
            body: JSON.stringify({
                model,
                stream: false,
                think: false,
                options: { num_predict: 24, temperature: 0 },
                messages: [{
                        role: "user",
                        content: "This picture has two halves, each one solid color. Name the left color, then the right one, in two words.",
                        images: [twoColorPng(left[1], right[1]).toString("base64")],
                    }],
            }),
            signal: controller.signal,
        });
        const body = (await res.json().catch(() => null));
        if (!res.ok || !body?.message) {
            const error = body?.error ?? `HTTP ${res.status}`;
            // llama.cpp's own words for a server started without its vision projector
            if (/image input is not supported|mmproj|does not support (images|vision)/i.test(error))
                return { ok: false, detail: error };
            return { ok: null, detail: error };
        }
        const said = (body.message.content ?? "").toLowerCase();
        const named = (c) => new RegExp(`\\b${c}\\b`).test(said);
        if (named(left[0]) && named(right[0]))
            return { ok: true, detail: `named ${left[0]} and ${right[0]}` };
        return { ok: false, detail: `drops images: shown ${left[0]} and ${right[0]}, it said "${said.trim().slice(0, 60)}"` };
    }
    catch (e) {
        return { ok: null, detail: controller.signal.aborted ? `no answer within ${timeoutMs / 1000}s` : describeError(e) };
    }
    finally {
        clearTimeout(timer);
    }
}
// ---- what each server was found to do (shared by every ask on this machine) ----
export const VISION_FILE = join(homedir(), ".eds_tui", "vision.json");
const SEES_FOR_MS = 7 * 24 * 3600_000;
const BLIND_FOR_MS = 24 * 3600_000;
let file = VISION_FILE;
let cache = null;
/** Tests: keep the verdicts somewhere else (and forget what was loaded). */
export function useVisionFile(path) {
    file = path;
    cache = null;
}
function load() {
    if (cache)
        return cache;
    try {
        cache = JSON.parse(readFileSync(file, "utf8")).servers ?? {};
    }
    catch {
        cache = {};
    }
    return cache;
}
/** What `server` was found to do with images for `model`: true, false, or undefined (not known, or too long ago). */
export function knownVision(server, model, now = Date.now()) {
    const v = load()[`${server} ${model}`];
    if (!v)
        return undefined;
    return now - v.at < (v.sees ? SEES_FOR_MS : BLIND_FOR_MS) ? v.sees : undefined;
}
export function rememberVision(server, model, sees, detail = "", now = Date.now()) {
    const list = load();
    list[`${server} ${model}`] = { sees, at: now, ...(detail ? { detail } : {}) };
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ servers: list }, null, 2));
    }
    catch {
        // can't save it: this run still remembers
    }
}
//# sourceMappingURL=vision.js.map