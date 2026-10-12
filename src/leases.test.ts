import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileLeases } from "./leases.js";

test("fileLeases: counts requests in flight per server, shared through the directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-leases-"));
  try {
    const a = fileLeases(dir);
    const b = fileLeases(dir); // another ask on the same machine sees the same files
    const r1 = a.acquire("http://runpod");
    const r2 = a.acquire("http://runpod");
    const r3 = b.acquire("http://n98");
    assert.equal(b.count("http://runpod"), 2);
    assert.equal(a.count("http://n98"), 1);
    r1();
    r1(); // releasing twice is harmless
    assert.equal(b.count("http://runpod"), 1);
    r2();
    r3();
    assert.equal(a.count("http://runpod") + a.count("http://n98"), 0);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fileLeases: a request left behind by a process that died doesn't count, and is cleaned up", () => {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-leases-"));
  try {
    const l = fileLeases(dir);
    const release = l.acquire("http://runpod");
    const mine = readdirSync(dir)[0]!;
    const dead = mine.replace(`.${process.pid}.`, ".999999999.");
    writeFileSync(join(dir, dead), "");
    assert.equal(l.count("http://runpod"), 1);
    assert.ok(!readdirSync(dir).includes(dead));
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
