import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ollama, Message } from "ollama";
import { agenticLoop, toolsFor, HARD_MAX_TURNS, SMALL_MAX_TURNS, type AgenticLoopDeps } from "./agent.js";
import * as skills from "./skills.js";

const MAIN = "main-model";
const SMALL = "small-model";
const CWD = tmpdir();

function baseDeps(client: Ollama, overrides: Partial<AgenticLoopDeps> = {}): AgenticLoopDeps {
  return {
    client,
    mainModel: MAIN,
    smallModel: SMALL,
    cwd: CWD,
    delegateTask: async () => "delegated result",
    delegateTaskMain: async () => "delegated result (main)",
    consultSpecialist: async () => "consult result",
    saveHistory: () => {},
    ...overrides,
  };
}

function toolCallResponse(command = "echo tick") {
  return {
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "run_command", arguments: { command } } }],
    } as Message,
  };
}

function finalResponse(content: string) {
  return { message: { role: "assistant", content } as Message };
}

test("no tool calls: returns the content directly and saves history", async () => {
  const savedHistories: Message[][] = [];
  const client = { chat: async () => finalResponse("the answer") } as unknown as Ollama;
  const deps = baseDeps(client, { saveHistory: (m) => savedHistories.push(m) });

  const messages: Message[] = [{ role: "user", content: "hi" }];
  const result = await agenticLoop(deps, messages, MAIN);

  assert.equal(result, "the answer");
  assert.equal(savedHistories.length, 1);
  assert.equal(messages[messages.length - 1]?.content, "the answer");
});

test("a tool_calls response dispatches to run_command via runCommandOnce, using a real subprocess", async () => {
  let callCount = 0;
  const client = {
    chat: async () => {
      callCount += 1;
      return callCount === 1 ? toolCallResponse("echo real-output") : finalResponse("done");
    },
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "run something" }];
  await agenticLoop(baseDeps(client), messages, MAIN, stats);

  assert.equal(stats.commands, 1);
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.equal(toolMsg?.content, "real-output");
});

test("escalation via turn-budget: small model always returns tool_calls; main gets a FULL FRESH 14-turn budget after escalation (turns resets to 1)", async () => {
  const calls: Array<{ model: string; hasTools: boolean }> = [];
  const client = {
    chat: async (req: any) => {
      calls.push({ model: req.model, hasTools: req.tools !== undefined });
      if (req.tools === undefined) return finalResponse("SALVAGED"); // the finalAnswer nudge call
      return toolCallResponse(); // both models loop forever otherwise
    },
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  const result = await agenticLoop(baseDeps(client), messages, SMALL, stats);

  const smallCalls = calls.filter((c) => c.model === SMALL && c.hasTools);
  const mainCalls = calls.filter((c) => c.model === MAIN && c.hasTools);

  assert.equal(smallCalls.length, SMALL_MAX_TURNS, "small model gets exactly its own SMALL_MAX_TURNS calls");
  assert.equal(mainCalls.length, HARD_MAX_TURNS, "main model gets a full fresh HARD_MAX_TURNS budget, not a reduced one");
  assert.equal(stats.escalated, true);
  assert.equal(stats.capped, true);
  assert.equal(result, "SALVAGED");
});

test("escalation via exception: small's chat() throws on its first call; turns is NOT reset, so main only gets HARD_MAX_TURNS-1 calls before the cap", async () => {
  const calls: Array<{ model: string; hasTools: boolean }> = [];
  let smallCallCount = 0;
  const client = {
    chat: async (req: any) => {
      calls.push({ model: req.model, hasTools: req.tools !== undefined });
      if (req.tools === undefined) return finalResponse("SALVAGED");
      if (req.model === SMALL) {
        smallCallCount += 1;
        throw new Error("small model unreachable");
      }
      return toolCallResponse();
    },
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  await agenticLoop(baseDeps(client), messages, SMALL, stats);

  assert.equal(smallCallCount, 1, "small is only ever attempted once — it escalates immediately on failure, no retry loop");
  const mainCalls = calls.filter((c) => c.model === MAIN && c.hasTools);
  assert.equal(
    mainCalls.length,
    HARD_MAX_TURNS - 1,
    "turns was NOT reset on exception-triggered escalation (unlike the turn-budget-exceeded path), so main starts from turns=2, not turns=1"
  );
});

test("hard cap still produces a real answer via finalAnswer, never silent failure", async () => {
  const client = {
    chat: async (req: any) => (req.tools === undefined ? finalResponse("conclusion from evidence") : toolCallResponse()),
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  const result = await agenticLoop(baseDeps(client), messages, MAIN, stats);

  assert.equal(stats.capped, true);
  assert.equal(result, "conclusion from evidence");
});

test("hard cap with no salvageable answer (finalAnswer's own call also fails) returns null, not a throw", async () => {
  const client = {
    chat: async (req: any) => {
      if (req.tools === undefined) throw new Error("even the salvage call failed");
      return toolCallResponse();
    },
  } as unknown as Ollama;

  const messages: Message[] = [{ role: "user", content: "go" }];
  const result = await agenticLoop(baseDeps(client), messages, MAIN);
  assert.equal(result, null);
});

test("WRAP_UP_NUDGE is appended to the last tool message exactly 2 and 1 rounds before the cap, not earlier", async () => {
  const client = {
    chat: async (req: any) => (req.tools === undefined ? finalResponse("done") : toolCallResponse()),
  } as unknown as Ollama;

  const messages: Message[] = [{ role: "user", content: "go" }];
  await agenticLoop(baseDeps(client), messages, MAIN);

  const nudged = messages.filter((m) => m.role === "tool" && m.content.includes("SYSTEM NOTE"));
  // left<=2 fires on turns=13 (left=1) and turns=12 (left=2) — exactly 2 tool messages carry the nudge.
  assert.equal(nudged.length, 2);
});

test("main model's own exception: salvages via finalAnswer when a tool message already exists", async () => {
  let callIndex = 0;
  const client = {
    chat: async (req: any) => {
      callIndex += 1;
      if (req.tools === undefined) return finalResponse("salvaged after main failure");
      if (callIndex === 1) return toolCallResponse(); // produces a tool message first
      throw new Error("main model exploded");
    },
  } as unknown as Ollama;

  const messages: Message[] = [{ role: "user", content: "go" }];
  const result = await agenticLoop(baseDeps(client), messages, MAIN);
  assert.equal(result, "salvaged after main failure");
});

test("main model's own exception with NO prior tool message: re-throws instead of salvaging (nothing to salvage from)", async () => {
  const client = {
    chat: async () => {
      throw new Error("main model exploded on the very first call");
    },
  } as unknown as Ollama;

  const messages: Message[] = [{ role: "user", content: "go" }];
  await assert.rejects(() => agenticLoop(baseDeps(client), messages, MAIN), /exploded on the very first call/);
});

test("delegate_task/load_skill/create_skill dispatch to the right handler and increment their own stats counter", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "eds-tui-agent-test-"));
  const realDir = skills.SKILLS_DIR;
  skills.setSkillsDir(tmp);
  try {
    mkdirSync(join(tmp, "known-skill"), { recursive: true });
    writeFileSync(join(tmp, "known-skill", "SKILL.md"), "---\ndescription: does a thing.\n---\n\nDo it.\n");
    skills.resetCache();

    let callIndex = 0;
    const client = {
      chat: async (req: any) => {
        callIndex += 1;
        if (callIndex === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { function: { name: "delegate_task", arguments: { task: "do a thing" } } },
                { function: { name: "load_skill", arguments: { name: "known-skill" } } },
                {
                  function: {
                    name: "create_skill",
                    arguments: { name: "new-one", description: "a new one.", body: "steps" },
                  },
                },
              ],
            } as Message,
          };
        }
        return finalResponse("all dispatched");
      },
    } as unknown as Ollama;

    let delegatedTask = "";
    const stats: any = {};
    const messages: Message[] = [{ role: "user", content: "go" }];
    await agenticLoop(
      baseDeps(client, {
        delegateTask: async (_c, task) => {
          delegatedTask = task;
          return "delegated ok";
        },
      }),
      messages,
      MAIN,
      stats
    );

    assert.equal(stats.delegations, 1);
    assert.equal(stats.skillsLoaded, 1);
    assert.equal(stats.skillsCreated, 1);
    assert.equal(delegatedTask, "do a thing");

    const toolResults = messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.ok(toolResults.some((c) => c === "delegated ok"));
    assert.ok(toolResults.some((c) => c.includes("does a thing")));
    assert.ok(toolResults.some((c) => c.includes("Saved and verified")));
    assert.ok(skills.get("new-one"), "create_skill's write must have actually landed on disk");
  } finally {
    skills.setSkillsDir(realDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("delegate_task: model:\"main\" dispatches to deps.delegateTaskMain, not deps.delegateTask", async () => {
  let callIndex = 0;
  const client = {
    chat: async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "delegate_task", arguments: { task: "do a thing", model: "main" } } }],
          } as Message,
        };
      }
      return finalResponse("done");
    },
  } as unknown as Ollama;

  let smallCalled = false;
  let mainTask = "";
  const messages: Message[] = [{ role: "user", content: "go" }];
  await agenticLoop(
    baseDeps(client, {
      delegateTask: async () => {
        smallCalled = true;
        return "wrong assistant";
      },
      delegateTaskMain: async (_c, task) => {
        mainTask = task;
        return "delegated to main";
      },
    }),
    messages,
    MAIN
  );

  assert.equal(mainTask, "do a thing");
  assert.equal(smallCalled, false, "model:\"main\" must not also call the small-model delegate function");
  const toolResults = messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.ok(toolResults.includes("delegated to main"));
});

test("delegate_task: no model argument (and model:\"small\") still dispatches to deps.delegateTask — default is unchanged", async () => {
  for (const modelArg of [undefined, "small"]) {
    let callIndex = 0;
    const client = {
      chat: async () => {
        callIndex += 1;
        if (callIndex === 1) {
          const args: Record<string, unknown> = { task: "do a thing" };
          if (modelArg !== undefined) args.model = modelArg;
          return {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "delegate_task", arguments: args } }],
            } as Message,
          };
        }
        return finalResponse("done");
      },
    } as unknown as Ollama;

    let mainCalled = false;
    const messages: Message[] = [{ role: "user", content: "go" }];
    await agenticLoop(
      baseDeps(client, {
        delegateTask: async () => "delegated to small",
        delegateTaskMain: async () => {
          mainCalled = true;
          return "wrong assistant";
        },
      }),
      messages,
      MAIN
    );

    assert.equal(mainCalled, false, `model:${JSON.stringify(modelArg)} must not call delegateTaskMain`);
    const toolResults = messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.ok(toolResults.includes("delegated to small"));
  }
});

test("consult_specialist dispatches to deps.consultSpecialist and increments stats.consultations", async () => {
  let callIndex = 0;
  let consultedTask = "";
  const client = {
    chat: async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "consult_specialist", arguments: { task: "write a tricky regex" } } }],
          } as Message,
        };
      }
      return finalResponse("done, incorporating the consult");
    },
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  await agenticLoop(
    baseDeps(client, {
      consultSpecialist: async (_c, task) => {
        consultedTask = task;
        return "Consultation with some-specialist concluded:\nhere is the regex";
      },
    }),
    messages,
    MAIN,
    stats
  );

  assert.equal(stats.consultations, 1);
  assert.equal(consultedTask, "write a tricky regex");
  const toolResults = messages.filter((m) => m.role === "tool").map((m) => m.content);
  assert.ok(toolResults.some((c) => c.includes("here is the regex")));
});

test("toolsFor: the small model always gets shell-only tools, regardless of skills installed or a pool being configured", () => {
  const tools = toolsFor(SMALL, SMALL, true);
  assert.deepEqual(
    tools.map((t) => t.function.name),
    ["run_command"]
  );
});

test("toolsFor: the main model gets the full set, minus load_skill when no skills exist, minus consult_specialist when no pool is configured", () => {
  const tmp = mkdtempSync(join(tmpdir(), "eds-tui-agent-toolsfor-"));
  const realDir = skills.SKILLS_DIR;
  skills.setSkillsDir(tmp);
  try {
    const names = toolsFor(MAIN, SMALL, false).map((t) => t.function.name);
    assert.deepEqual(names, ["run_command", "delegate_task", "delegate_tasks", "create_skill"]);
  } finally {
    skills.setSkillsDir(realDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("toolsFor: the main model gets load_skill added once at least one skill exists", () => {
  const tmp = mkdtempSync(join(tmpdir(), "eds-tui-agent-toolsfor-2-"));
  const realDir = skills.SKILLS_DIR;
  skills.setSkillsDir(tmp);
  try {
    mkdirSync(join(tmp, "x"), { recursive: true });
    writeFileSync(join(tmp, "x", "SKILL.md"), "---\ndescription: x.\n---\n\nx.\n");
    skills.resetCache();

    const names = toolsFor(MAIN, SMALL, false).map((t) => t.function.name);
    assert.deepEqual(names, ["run_command", "delegate_task", "delegate_tasks", "create_skill", "load_skill"]);
  } finally {
    skills.setSkillsDir(realDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("toolsFor: a third (specialist) model that is neither main nor small also gets the full set", () => {
  const tmp = mkdtempSync(join(tmpdir(), "eds-tui-agent-toolsfor-3-"));
  const realDir = skills.SKILLS_DIR;
  skills.setSkillsDir(tmp);
  try {
    const tools = toolsFor("some-specialist-model:8b", SMALL, false);
    assert.deepEqual(
      tools.map((t) => t.function.name),
      ["run_command", "delegate_task", "delegate_tasks", "create_skill"]
    );
  } finally {
    skills.setSkillsDir(realDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("toolsFor: consult_specialist is added for the main model (and a third specialist model) when a pool is configured", () => {
  const tmp = mkdtempSync(join(tmpdir(), "eds-tui-agent-toolsfor-4-"));
  const realDir = skills.SKILLS_DIR;
  skills.setSkillsDir(tmp);
  try {
    assert.deepEqual(toolsFor(MAIN, SMALL, true).map((t) => t.function.name), [
      "run_command",
      "delegate_task",
      "delegate_tasks",
      "create_skill",
      "consult_specialist",
    ]);
    assert.deepEqual(toolsFor("some-specialist-model:8b", SMALL, true).map((t) => t.function.name), [
      "run_command",
      "delegate_task",
      "delegate_tasks",
      "create_skill",
      "consult_specialist",
    ]);
  } finally {
    skills.setSkillsDir(realDir);
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- Tier 3: specialist-model escalation ----------
// Mock discriminator for these tests: a real round (main or specialist)
// always passes `tools`; the pick-specialist call (model-pool.ts) omits
// `tools` but sets `think`; the finalAnswer nudge call omits both. This
// lets one mock client distinguish all three without any other signal.
const SPECIALIST = "specialist-model";
const POOL = [{ name: SPECIALIST, goodFor: "deep reasoning" }];

test("tier 3: main exhausting its turn budget escalates to the pool-picked specialist, with a full fresh budget and full tools", async () => {
  const calls: Array<{ model: string; tools: boolean; kind: string }> = [];
  const client = {
    chat: async (req: any) => {
      const kind = req.tools !== undefined ? "round" : req.think !== undefined ? "pick" : "final";
      calls.push({ model: req.model, tools: req.tools !== undefined, kind });
      if (kind === "pick") return finalResponse(SPECIALIST);
      if (kind === "round" && req.model === SPECIALIST) return finalResponse("specialist's answer");
      return toolCallResponse(); // main just keeps calling tools forever
    },
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "a very hard task" }];
  const result = await agenticLoop(baseDeps(client, { modelPool: POOL }), messages, MAIN, stats);

  const mainRounds = calls.filter((c) => c.kind === "round" && c.model === MAIN);
  const specialistRounds = calls.filter((c) => c.kind === "round" && c.model === SPECIALIST);
  const pickCalls = calls.filter((c) => c.kind === "pick");

  assert.equal(mainRounds.length, HARD_MAX_TURNS, "main gets its full normal budget before tier 3 is even considered");
  assert.equal(pickCalls.length, 1);
  assert.equal(specialistRounds.length, 1, "the specialist got a fresh budget and concluded on its first real call");
  assert.equal(stats.specialistModel, SPECIALIST);
  assert.equal(stats.capped, true);
  assert.equal(result, "specialist's answer");

  // The specialist must get the SAME full tool access main does, not the
  // small model's shell-only set — it's standing in because it has MORE
  // capability for this task, not less.
  const specialistCallRaw = calls.find((c) => c.kind === "round" && c.model === SPECIALIST);
  assert.ok(specialistCallRaw?.tools);
});

test("tier 3: no pool configured — falls back to the existing same-model salvage behavior, completely unchanged", async () => {
  const calls: string[] = [];
  const client = {
    chat: async (req: any) => {
      calls.push(req.model);
      if (req.tools === undefined) return finalResponse("salvaged from main itself");
      return toolCallResponse();
    },
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  const result = await agenticLoop(baseDeps(client, { modelPool: [] }), messages, MAIN, stats);

  assert.equal(stats.specialistModel, null);
  assert.equal(result, "salvaged from main itself");
  assert.ok(calls.every((m) => m === MAIN), "never called anything but main — no pool means tier 3 never fires");
});

test("tier 3: escalates at most once — if the specialist ALSO exhausts its budget, falls back to salvaging on the specialist itself, not a second escalation", async () => {
  const calls: Array<{ model: string; kind: string }> = [];
  const client = {
    chat: async (req: any) => {
      const kind = req.tools !== undefined ? "round" : req.think !== undefined ? "pick" : "final";
      calls.push({ model: req.model, kind });
      if (kind === "pick") return finalResponse(SPECIALIST);
      if (kind === "final") return finalResponse("salvaged from the specialist");
      return toolCallResponse(); // both main and the specialist loop forever
    },
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  const result = await agenticLoop(baseDeps(client, { modelPool: POOL }), messages, MAIN, stats);

  assert.equal(calls.filter((c) => c.kind === "pick").length, 1, "the pool is only ever consulted once per run");
  assert.equal(stats.specialistModel, SPECIALIST);
  assert.equal(result, "salvaged from the specialist");
});

test("tier 3 via the exception path: turns is NOT reset (matches the existing small→main exception asymmetry), and the specialist only gets hardMaxTurns-1 calls", async () => {
  const calls: Array<{ model: string; kind: string }> = [];
  let mainAttempts = 0;
  const client = {
    chat: async (req: any) => {
      const kind = req.tools !== undefined ? "round" : req.think !== undefined ? "pick" : "final";
      calls.push({ model: req.model, kind });
      if (kind === "pick") return finalResponse(SPECIALIST);
      if (kind === "final") return finalResponse("salvaged");
      if (kind === "round" && req.model === MAIN) {
        mainAttempts += 1;
        throw new Error("main model unreachable");
      }
      return toolCallResponse(); // specialist loops forever once escalated to
    },
  } as unknown as Ollama;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  await agenticLoop(baseDeps(client, { modelPool: POOL }), messages, MAIN, stats);

  assert.equal(mainAttempts, 1, "main is only ever attempted once before escalating on its own exception");
  const specialistRounds = calls.filter((c) => c.kind === "round" && c.model === SPECIALIST);
  assert.equal(
    specialistRounds.length,
    HARD_MAX_TURNS - 1,
    "turns was not reset on this escalation path, so the specialist starts from turns=2, not turns=1 — one fewer call before the cap"
  );
});

// ---------- delegate_tasks: parallel fan-out ----------

test("delegate_tasks: runs all tasks genuinely CONCURRENTLY, not sequentially — total wall-clock is ~1 delay, not N", async () => {
  const DELAY_MS = 150;
  const N = 4;
  let inFlight = 0;
  let maxInFlight = 0;

  const client = {
    chat: async (req: any) => {
      if (req.tools === undefined) return finalResponse("done"); // finalAnswer/wrap-up path, unused here
      return toolCallResponse();
    },
  } as unknown as Ollama;

  const delegateTask = async (_c: Ollama, task: string): Promise<string> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, DELAY_MS));
    inFlight -= 1;
    return `report for: ${task}`;
  };

  let callIndex = 0;
  const dispatchClient = {
    chat: async (req: any) => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "delegate_tasks",
                  arguments: { tasks: Array.from({ length: N }, (_, i) => `task ${i + 1}`) },
                },
              },
            ],
          } as Message,
        };
      }
      return finalResponse("all done");
    },
  } as unknown as Ollama;

  const messages: Message[] = [{ role: "user", content: "go" }];
  const stats: any = {};
  const started = Date.now();
  await agenticLoop(baseDeps(dispatchClient, { delegateTask }), messages, MAIN, stats);
  const elapsedMs = Date.now() - started;

  assert.equal(maxInFlight, N, "all N tasks must have been in flight at the same time — proves real concurrency, not sequential dispatch");
  assert.ok(
    elapsedMs < DELAY_MS * N,
    `elapsed (${elapsedMs}ms) should be well under N sequential delays (${DELAY_MS * N}ms) if genuinely parallel`
  );
  assert.equal(stats.delegations, N, "each task counts as its own delegation");
});

test("delegate_tasks: model:\"main\" fans every task out through deps.delegateTaskMain, concurrently — not deps.delegateTask", async () => {
  const DELAY_MS = 100;
  const N = 3;
  let inFlight = 0;
  let maxInFlight = 0;
  let smallCalled = false;

  const delegateTaskMain = async (_c: Ollama, task: string): Promise<string> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, DELAY_MS));
    inFlight -= 1;
    return `main report for: ${task}`;
  };

  let callIndex = 0;
  const client = {
    chat: async () => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                function: {
                  name: "delegate_tasks",
                  arguments: { tasks: Array.from({ length: N }, (_, i) => `task ${i + 1}`), model: "main" },
                },
              },
            ],
          } as Message,
        };
      }
      return finalResponse("all done");
    },
  } as unknown as Ollama;

  const messages: Message[] = [{ role: "user", content: "go" }];
  const started = Date.now();
  await agenticLoop(
    baseDeps(client, {
      delegateTask: async () => {
        smallCalled = true;
        return "wrong assistant";
      },
      delegateTaskMain,
    }),
    messages,
    MAIN
  );
  const elapsedMs = Date.now() - started;

  assert.equal(smallCalled, false, "model:\"main\" must not touch deps.delegateTask at all");
  assert.equal(maxInFlight, N, "all N main-model tasks must have been in flight at the same time");
  assert.ok(elapsedMs < DELAY_MS * N, `elapsed (${elapsedMs}ms) should be well under N sequential delays`);
});

test("delegate_tasks: combines each task's report, labeled by task number, in order", async () => {
  let callIndex = 0;
  const client = {
    chat: async (req: any) => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "delegate_tasks", arguments: { tasks: ["count files", "check git branch"] } } }],
          } as Message,
        };
      }
      return finalResponse("summarized");
    },
  } as unknown as Ollama;

  const delegateTask = async (_c: Ollama, task: string): Promise<string> =>
    task === "count files" ? "42 files" : "on main";

  const messages: Message[] = [{ role: "user", content: "go" }];
  await agenticLoop(baseDeps(client, { delegateTask }), messages, MAIN);

  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg!.content, /Task 1: count files\nResult: 42 files/);
  assert.match(toolMsg!.content, /Task 2: check git branch\nResult: on main/);
});

test("delegate_tasks: an empty tasks array degrades gracefully, no delegateTask calls at all", async () => {
  let delegateCallCount = 0;
  let callIndex = 0;
  const client = {
    chat: async (req: any) => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{ function: { name: "delegate_tasks", arguments: { tasks: [] } } }],
          } as Message,
        };
      }
      return finalResponse("noted");
    },
  } as unknown as Ollama;

  const delegateTask = async (): Promise<string> => {
    delegateCallCount += 1;
    return "should not happen";
  };

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  await agenticLoop(baseDeps(client, { delegateTask }), messages, MAIN, stats);

  assert.equal(delegateCallCount, 0);
  assert.equal(stats.delegations, 0);
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg!.content, /No tasks were given/);
});

test("delegate_tasks: non-string entries in the tasks array are filtered out rather than crashing", async () => {
  let callIndex = 0;
  const client = {
    chat: async (req: any) => {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "delegate_tasks", arguments: { tasks: ["real task", 42, null, { not: "a string" }] } } },
            ],
          } as Message,
        };
      }
      return finalResponse("done");
    },
  } as unknown as Ollama;

  const delegateTask = async (_c: Ollama, task: string): Promise<string> => `handled: ${task}`;

  const stats: any = {};
  const messages: Message[] = [{ role: "user", content: "go" }];
  await agenticLoop(baseDeps(client, { delegateTask }), messages, MAIN, stats);

  assert.equal(stats.delegations, 1, "only the one real string task counted");
  const toolMsg = messages.find((m) => m.role === "tool");
  assert.match(toolMsg!.content, /Task 1: real task\nResult: handled: real task/);
});

// ---------- compaction integration ----------

test("compaction: an oversized pre-existing transcript is compacted before the first round runs, without disturbing turn-budget bookkeeping", async () => {
  const messages: Message[] = [{ role: "user", content: "go" }];
  for (let i = 1; i <= 10; i++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "run_command", arguments: { command: `step-${i}` } } }],
    } as Message);
    messages.push({ role: "tool", content: `${"x".repeat(7000)} marker-${i}` } as Message);
  }
  const totalBefore = messages.reduce((n, m) => n + (m.content ?? "").length, 0);
  assert.ok(totalBefore > 60_000, "fixture must actually exceed the compaction threshold");

  const client = {
    chat: async (req: any) => {
      if (req.tools === undefined) {
        // maybeCompact's own summarization call — no `tools` key at all,
        // unlike the main loop's own "Thinking..." call, which always sets one.
        return { message: { role: "assistant", content: "condensed summary" } as Message };
      }
      return finalResponse("concluded normally");
    },
  } as unknown as Ollama;

  const stats: any = {};
  const result = await agenticLoop(baseDeps(client), messages, MAIN, stats);

  assert.equal(result, "concluded normally");
  assert.equal(stats.compactions, 1);
  // turns/total are plain local counters, fully decoupled from messages.length
  // -- compaction mutating `messages` must not perturb them.
  assert.equal(stats.turns, 1);
  assert.equal(stats.capped, false);
  assert.equal(stats.escalated, false);

  const totalAfter = messages.reduce((n, m) => n + (m.content ?? "").length, 0);
  assert.ok(totalAfter < totalBefore, "the transcript must actually have shrunk");
});
