import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginTurn, endTurn, garbled, helped, helperOrder, learn, RETRY_MS, score, trusted, useExperienceFile } from "./experience.js";

const file = join(mkdtempSync(join(tmpdir(), "eds-tui-experience-")), "helper-experience.json");
useExperienceFile(file); // never the real ~/.eds_tui

test("experience: a message's helpers are scored by how it ended, per kind; Esc counts for nobody", () => {
  assert.equal(beginTurn("journalctl -u ollama shows errors"), "logs");
  helped("pi");
  endTurn("done");
  beginTurn("show me the logs");
  helped("pi");
  endTurn("stopped");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual([saved.pi.good, saved.pi.bad, saved.pi.kinds.logs.good], [1, 0, 1]);
  assert.ok(score("pi", "logs") > score("pi", "git"));
});

test("experience: failing twice at a kind (more than twice as often as not) stops that kind, for RETRY_MS", () => {
  learn("small", true, "docker");
  learn("small", true, "docker");
  learn("small", true, "docker");
  beginTurn("what is using port 8080");
  garbled("small", "an empty reply");
  learn("small", false, "network");
  const now = Date.now();
  assert.ok(!trusted("small", "network", now) && trusted("small", "docker", now) && trusted("small", undefined, now));
  assert.ok(trusted("small", "network", now + RETRY_MS + 1000), "one more chance later");
  const order = helperOrder([{ model: "small" }, { model: "other" }], "network", now);
  assert.deepEqual(order.map((s) => s.model), ["other"]);
  assert.deepEqual(helperOrder([{ model: "other" }, { model: "small" }], "docker", now).map((s) => s.model), ["small", "other"]);
});
