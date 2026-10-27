import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { Message, Ollama } from "ollama";
import {
  findImagePaths,
  hasImages,
  keepRecentImages,
  knownVision,
  loadImage,
  probeVision,
  rememberVision,
  twoColorPng,
  useVisionFile,
  viewedImagesMessage,
  withoutImages,
  attachedNote,
} from "./vision.js";
import { withNodeRouting } from "./nodes.js";
import { memoryLeases } from "./leases.js";
import { agenticLoop, type AgenticLoopDeps } from "./agent.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "eds-tui-vision-"));
}

test("twoColorPng: a real PNG of the asked size, left half one color and right half the other", () => {
  const png = twoColorPng([255, 0, 0], [0, 0, 255], 8, 2);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 8);
  assert.equal(png.readUInt32BE(20), 2);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString("ascii", 37, 41), "IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, 2 * (1 + 8 * 3));
  assert.deepEqual([...raw.subarray(1, 4)], [255, 0, 0]); // first pixel
  assert.deepEqual([...raw.subarray(1 + 7 * 3, 1 + 8 * 3)], [0, 0, 255]); // last pixel
});

test("findImagePaths: existing image files a message names, with ~, quotes, escaped spaces and punctuation", () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "a.jpg"), "x");
    writeFileSync(join(dir, "my pic.PNG"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    mkdirSync(join(dir, "folder.png"));
    const found = findImagePaths(
      `look at a.jpg, "my pic.PNG" and my\\ pic.PNG and missing.jpg, notes.txt, folder.png (${join(dir, "a.jpg")})`,
      dir
    );
    assert.deepEqual(found, [join(dir, "a.jpg"), join(dir, "my pic.PNG")]);
    assert.deepEqual(findImagePaths("no pictures here", dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadImage: a file becomes base64 the model can take; a missing file or a folder says so", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "p.png"), twoColorPng([0, 255, 0], [255, 255, 0]));
    const img = await loadImage("p.png", dir);
    assert.equal(img.path, join(dir, "p.png"));
    assert.ok(img.data.length > 100);
    const head = Buffer.from(img.data, "base64").subarray(0, 3);
    // shrunk to JPEG when ImageMagick or ffmpeg is here, else the PNG as it is
    assert.ok(head[0] === 0xff || head[0] === 0x89, `unexpected header ${head.toString("hex")}`);
    await assert.rejects(loadImage("nope.jpg", dir), /no such file/);
    await assert.rejects(loadImage(".", dir), /is a folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keepRecentImages: only the newest images stay attached; older messages lose theirs and say so", () => {
  const messages: Message[] = [
    { role: "user", content: "old", images: ["1", "2"] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "mid", images: ["3"] },
    { role: "user", content: "new", images: ["4", "5"] },
  ];
  keepRecentImages(messages, 4);
  assert.deepEqual(messages[0]!.images, ["2"]);
  assert.match(messages[0]!.content, /dropped/);
  assert.deepEqual(messages[3]!.images, ["4", "5"]);
  keepRecentImages(messages, 2);
  assert.equal(messages[0]!.images, undefined);
  assert.equal(messages[2]!.images, undefined);
  assert.equal(messages[0]!.content.match(/dropped/g)?.length, 1, "said once");
  assert.ok(hasImages({ messages }));
  keepRecentImages(messages, 0);
  assert.ok(!hasImages({ messages }));
});

/** A fake server for probeVision: its /api/show capabilities and what /api/chat answers to the picture. */
function visionServer(o: { caps?: string[]; answer?: (colors: string) => string; error?: [number, string] }) {
  const seen: any[] = [];
  const fetchFn = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, headers: init.headers });
    if (url.endsWith("/api/show")) return new Response(JSON.stringify({ capabilities: o.caps ?? ["completion", "vision"] }));
    if (o.error) return new Response(JSON.stringify({ error: o.error[1] }), { status: o.error[0] });
    return new Response(JSON.stringify({ done: true, message: { role: "assistant", content: o.answer!("") } }));
  }) as unknown as typeof fetch;
  return { fetchFn, seen };
}

test("probeVision: a server that names both colors sees; one that guesses wrong drops images", async () => {
  const pick = () => [0, 2] as [number, number]; // red, blue
  const good = visionServer({ answer: () => "Red, blue." });
  assert.deepEqual((await probeVision("http://s", "qwen3.8:latest", { fetchFn: good.fetchFn, pick, token: "t" })).ok, true);
  const chat = good.seen.find((r) => r.url === "http://s/api/chat");
  assert.equal(chat.body.messages[0].images.length, 1);
  assert.equal(chat.headers.Authorization, "Bearer t");

  const blind = visionServer({ answer: () => "Black and white" });
  const r = await probeVision("http://s", "qwen3.8:latest", { fetchFn: blind.fetchFn, pick });
  assert.equal(r.ok, false);
  assert.match(r.detail, /drops images/);
});

test("probeVision: no 'vision' capability, or llama.cpp without its projector, is blind; any other failure can't tell", async () => {
  const noVision = visionServer({ caps: ["completion", "tools"] });
  assert.equal((await probeVision("http://s", "m", { fetchFn: noVision.fetchFn })).ok, false);
  assert.equal(noVision.seen.length, 1, "not even asked to look");

  const mmproj = visionServer({ error: [500, "image input is not supported - hint: you may need to provide the mmproj"] });
  assert.equal((await probeVision("http://s", "m", { fetchFn: mmproj.fetchFn })).ok, false);

  const down = visionServer({ error: [502, "Bad Gateway"] });
  assert.equal((await probeVision("http://s", "m", { fetchFn: down.fetchFn })).ok, null);
});

test("knownVision: a verdict is kept (a week for sees, a day for can't), in the file every ask shares", () => {
  const dir = tempDir();
  try {
    useVisionFile(join(dir, "vision.json"));
    const t = 1_000_000_000_000;
    rememberVision("http://a", "m", true, "", t);
    rememberVision("http://b", "m", false, "", t);
    useVisionFile(join(dir, "vision.json")); // read back from the file
    assert.equal(knownVision("http://a", "m", t + 3 * 24 * 3600_000), true);
    assert.equal(knownVision("http://b", "m", t + 3600_000), false);
    assert.equal(knownVision("http://b", "m", t + 2 * 24 * 3600_000), undefined);
    assert.equal(knownVision("http://a", "m", t + 8 * 24 * 3600_000), undefined);
    assert.equal(knownVision("http://a", "other", t), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- routing a request with images (nodes.ts) ----------

function visionRouting(o: { sees: Record<string, boolean | null>; ranking?: Record<string, { est: number; at: number }>; slots?: Record<string, number>; now?: () => number }) {
  const dir = tempDir();
  useVisionFile(join(dir, "vision.json"));
  const reached: string[] = [];
  const probed: string[] = [];
  const reply = (from: string) => ({
    chat: async () => {
      reached.push(from);
      return (async function* () {
        yield { done: true, message: { role: "assistant", content: `from ${from}` } };
      })();
    },
  });
  const hub = reply("hub") as any;
  const urls = Object.keys(o.sees);
  withNodeRouting(hub, { direct: urls, lastResort: [], slots: o.slots ?? {} }, {
    probe: async () => ({ ok: true, detail: "ok" }),
    visionProbe: async (url) => {
      probed.push(url);
      return { ok: o.sees[url]!, detail: "test" };
    },
    makeClient: (url) => reply(url) as any,
    retry: { delaysMs: [0], sleep: async () => {} },
    leases: memoryLeases(),
    ranking: () => o.ranking ?? {},
    ...(o.now ? { now: o.now } : {}),
  });
  const ask = (images?: string[]) =>
    hub.chat({ model: "qwen3.8:latest", messages: [{ role: "user", content: "look", ...(images ? { images } : {}) }] });
  return { ask, reached, probed, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("routing: a request with images skips the strongest server when it can't see, and goes to one that does", async () => {
  const RP = "http://runpod", HOME = "http://home:11434";
  const s = visionRouting({ sees: { [RP]: false, [HOME]: true }, ranking: { [RP]: { est: 1, at: 1 }, [HOME]: { est: 5, at: 1 } } });
  try {
    assert.equal((await s.ask(["aW1n"])).message.content, `from ${HOME}`);
    assert.equal((await s.ask()).message.content, `from ${RP}`, "without images: the strongest, as always");
    await s.ask(["aW1n"]);
    assert.deepEqual(s.probed, [RP, HOME], "each server asked once, then remembered");
  } finally {
    s.done();
  }
});

test("routing: no server that sees images is an error saying so, never the hub (it may pick one that makes the picture up)", async () => {
  let t = 0;
  const s = visionRouting({ sees: { "http://runpod": false, "http://down": null }, now: () => t });
  try {
    await assert.rejects(s.ask(["aW1n"]), /can look at images.*runpod can't see images/);
    assert.ok(!s.reached.includes("hub"));
    await assert.rejects(s.ask(["aW1n"]));
    assert.deepEqual(s.probed, ["http://runpod", "http://down"], "not asked again right away");
    t += 61_000;
    await assert.rejects(s.ask(["aW1n"]));
    assert.deepEqual(s.probed, ["http://runpod", "http://down", "http://down"], "a server that couldn't tell is asked again later");
  } finally {
    s.done();
  }
});

// ---------- view_image in the agentic loop ----------

test("agenticLoop: view_image attaches the picture after the round's tool results, for the next request", async () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, "w.png"), twoColorPng([0, 0, 0], [255, 255, 255]));
    const requests: any[] = [];
    const client = {
      chat: async (req: any) => {
        requests.push(structuredClone(req));
        return requests.length === 1
          ? { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "view_image", arguments: { path: "w.png" } } }, { function: { name: "view_image", arguments: { path: "gone.jpg" } } }] } }
          : { message: { role: "assistant", content: "black and white" } };
      },
    } as unknown as Ollama;
    const deps: AgenticLoopDeps = {
      client, mainModel: "m", smallModel: "m", cwd: dir, saveHistory: () => {},
      delegateTask: async () => "", delegateTaskMain: async () => "", consultSpecialist: async () => "",
    };
    const messages: Message[] = [{ role: "user", content: "what colors?" }];
    assert.equal(await agenticLoop(deps, messages, "m"), "black and white");
    const sent: Message[] = requests[1].messages;
    assert.deepEqual(sent.slice(-3).map((m) => m.role), ["tool", "tool", "user"]);
    assert.match(sent[sent.length - 3]!.content, /Loaded .*w\.png/);
    assert.match(sent[sent.length - 2]!.content, /view_image failed: no such file/);
    assert.equal(sent[sent.length - 1]!.images?.length, 1);
    assert.match(sent[sent.length - 1]!.content, /^\[view_image\]/);
    assert.ok(requests[0].tools.some((t: any) => t.function.name === "view_image"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("viewedImagesMessage: one user message, the images in order, saying where they came from", () => {
  const m = viewedImagesMessage([
    { path: "/a.jpg", data: "A", note: "" },
    { path: "/b.png", data: "B", note: "" },
  ]);
  assert.equal(m.role, "user");
  assert.deepEqual(m.images, ["A", "B"]);
  assert.match(m.content, /\/a\.jpg, \/b\.png/);
});

test("withoutImages / attachedNote: what a message says when its images are left out, or already attached", () => {
  const once = withoutImages({ role: "user", content: "look", images: ["A"] });
  assert.match(once, /^look\n\(An image was attached here earlier/);
  assert.equal(withoutImages({ role: "user", content: once, images: ["A"] }), once, "said once");
  assert.equal(withoutImages({ role: "user", content: "plain" }), "plain");
  assert.match(attachedNote(["/a.png", "/b.jpg"]), /\/a\.png, \/b\.jpg\. No need to call view_image/);
});
