import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { learningSource, playbookNotes, runLog } from "./learning.js";

const BOOK = { path: "wiki/processes/playbook-restart-ollama.md", title: "Restart Ollama", when: "it stops answering",
  steps: "1. `systemctl restart ollama`", worked: 2, status: "verified" };
const REPORT = { run: "ab12cd34ef56ab78", outcome: "done" as const, request: "ollama is down", log: "> systemctl restart ollama",
  reply: "Restarted.", given: [BOOK.path], folder: "/root" };

test("learning: none for the center's own tasks, when switched off, or with no way to the center", () => {
  const router = { url: "http://127.0.0.1:1/llm", token: "t" };
  assert.equal(learningSource({ CC_TASK_ID: "12" }, router), undefined);
  assert.equal(learningSource({ EDS_TUI_LEARNING: "0" }, router), undefined);
  assert.equal(learningSource({}, undefined, undefined), undefined);
  assert.equal(learningSource({}, router)?.via, "center");
});

test("learning: on the center's machine, through its router's address and login", async () => {
  const seen: Array<[string, string, string | undefined]> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push([req.method!, req.url!, req.headers.authorization]);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url!.startsWith("/api/v1/learning/playbooks") ? { playbooks: [BOOK] }
        : { reviewed: JSON.parse(body).outcome === "done" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as any).port;
    const src = learningSource({}, { url: `http://127.0.0.1:${port}/llm`, token: "tok" })!;
    assert.deepEqual(await src.search("ollama is down"), [BOOK]);
    assert.equal(await src.report(REPORT), true);
    assert.deepEqual(seen.map(([m, u, a]) => [m, u.split("?")[0], a]), [
      ["GET", "/api/v1/learning/playbooks", "Bearer tok"], ["POST", "/api/v1/learning/runs", "Bearer tok"]]);
    assert.ok(seen[0]![1].includes("q=ollama+is+down") && seen[0]![1].includes("limit=3"));
  } finally {
    server.close();
  }
});

test("learning: on another server, through ccd-node (its token never reaches ask); a failure is no playbooks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-learning-"));
  const bin = join(dir, "ccd-node");
  writeFileSync(bin, `#!/bin/sh
echo "$@" >> "${dir}/args"
if [ "$2" = search ]; then echo '{"playbooks": [{"path": "p.md", "title": "T"}]}'; else cat > "${dir}/report"; echo '{"reviewed": true}'; fi
`);
  chmodSync(bin, 0o755);
  const src = learningSource({}, undefined, bin)!;
  assert.equal(src.via, "ccd-node");
  assert.deepEqual(await src.search("disk is full"), [{ path: "p.md", title: "T" }]);
  assert.equal(await src.report(REPORT), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "report"), "utf8")), REPORT);
  assert.match(readFileSync(join(dir, "args"), "utf8"), /^learning search disk is full --limit 3\nlearning run\n$/);
  writeFileSync(bin, "#!/bin/sh\necho '{\"error\": \"down\"}'; exit 1\n");
  assert.deepEqual(await src.search("disk is full"), []);
  assert.equal(await learningSource({}, undefined, join(dir, "missing"))!.report(REPORT), false);
});

test("learning: the notes for the prompt, and what a message's work ran", () => {
  const notes = playbookNotes([BOOK]);
  assert.match(notes, /^Playbooks from earlier tasks that may fit/);
  assert.ok(notes.includes("### Restart Ollama (verified, worked 2×) — wiki/processes/playbook-restart-ollama.md\nWhen: it stops answering\n1."));
  const log = runLog([
    { role: "user", content: "before" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "run_command", arguments: { command: "systemctl status ollama" } } }] },
    { role: "tool", content: "inactive (dead)\nsince 10:00" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "load_skill", arguments: { name: "x" } } }] },
    { role: "assistant", content: "Restarted." },
  ] as any, 1);
  assert.equal(log, '> systemctl status ollama\n  inactive (dead)\n  since 10:00\n[load_skill] {"name":"x"}');
});
