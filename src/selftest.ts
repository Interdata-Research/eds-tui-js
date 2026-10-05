// Ported from eds_tui/main.py's self_check() (--test). Exercises the whole
// arrangement against a live server and reports pass/fail, exiting nonzero
// if anything broke — this suite is itself the acceptance test for the
// whole port's behavioral parity with the Python original.
//
// One real design deviation from the Python original, not a port gap:
// escalation_fires()/cap_still_answers() there temporarily mutate the
// module-global SMALL_MAX_TURNS/HARD_MAX_TURNS constants
// (`globals()["SMALL_MAX_TURNS"] = 1`) to force escalation/capping quickly.
// agent.ts's constants are real `const` exports (safer for normal use, not
// externally mutable), so agenticLoop() instead accepts optional
// smallMaxTurns/hardMaxTurns overrides in its deps for exactly this case —
// see agent.ts's AgenticLoopDeps doc comment. bad_small_model_falls_back()
// similarly needed no globals-mutation equivalent at all here, since
// triage() already takes smallModel as a plain parameter rather than
// reading a module global.

import chalk from "chalk";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "ollama";

import { makeClient, desiredModels } from "./client.js";
import { triage } from "./triage.js";
import { resolveModel, type TriageFn } from "./resolve-model.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { agenticLoop, HARD_MAX_TURNS, type AgenticLoopDeps } from "./agent.js";
import { makeDelegateTask } from "./subagent.js";
import { makeConsultSpecialist } from "./consult.js";
import { clipOutput, MAX_OUTPUT_CHARS } from "./clip.js";
import { runCommandOnce } from "./exec.js";
import * as skills from "./skills.js";
import { displayModel, printRetrying, printDirectNodeState } from "./ui.js";
import { withDirectNodes, loadDirectNodes } from "./nodes.js";
import { withRetries } from "./retry.js";

const SIMPLE_PROBE = "how many .py files are in this directory";
const COMPLEX_PROBE =
  "refactor the agentic loop into its own module and explain the tradeoffs of each approach";
const DELEGATION_PROBE =
  "Delegate two subtasks: first, count how many *.py files are in the current directory; " +
  "second, report the name of the current git branch. Then give me both answers.";
const ESCALATION_PROBE = "Run 'pwd', then separately run 'whoami', then report both results.";
// A real model confirmed present on the live interdata network (not a
// fixture name that would just fail to resolve) — proves an actual
// escalation to an actual model, not just that the mechanism fires.
const SPECIALIST_FIXTURE_POOL = [
  { name: "deepseek-r1:8b", goodFor: "deep multi-step reasoning, math, logic, number theory" },
];
// Deliberately NOT ESCALATION_PROBE (a trivial pwd/whoami task) — verified
// live that the small model correctly (!) declines to escalate a trivial
// task to a reasoning specialist even when hardMaxTurns is artificially
// forced to 1, since the pick decision judges the TASK, not why the cap
// was hit. Also verified live that an explicit "first run X, THEN solve
// this step by step" framing confuses the small model's routing judgment
// (it starts answering the embedded task instead of picking a model, or
// judges NONE) — this probe instead poses ONE coherent problem that
// naturally requires a real command (forcing hardMaxTurns:1 to actually
// bite on round 2) and is genuinely reasoning-heavy, without any
// meta-instruction language competing with the routing system prompt.
const SPECIALIST_PROBE =
  "How many .ts files are in the current directory? Once you know that count N, " +
  "prove step by step whether N is a prime number, and if not, find all its prime " +
  "factors with full mathematical reasoning.";

// consult_specialist (a proactive, per-call hand-off that keeps control) is
// deliberately probed with the SAME fixture pool/model as tier-3's
// SPECIALIST_FIXTURE_POOL/deepseek-r1:8b, but hardMaxTurns is left at its
// real default here (NOT forced to 1) — the point is proving the main
// model reaches for the tool BY CHOICE for one sub-piece, not that it was
// forced into it by budget exhaustion. The probe explicitly frames a trivial
// part to do directly and a much harder part to get a second opinion on, so
// the choice to consult is well-motivated rather than relying on the model
// to invent that judgement call unprompted.
const CONSULT_FIXTURE_POOL = [
  { name: "deepseek-r1:8b", goodFor: "extremely hard step-by-step mathematical proofs and number theory" },
];
const CONSULT_PROBE =
  "First run 'pwd' yourself — that part is trivial. Then, for the much harder part, get a " +
  "second opinion from a specialist on a rigorous step-by-step proof of whether 8191 is a " +
  "prime number. Once you have that, report both the working directory and the primality " +
  "conclusion in your own final answer.";

// A skill nothing else on the machine could satisfy, so a match proves the
// skill reached the model rather than the model already knowing the answer.
const FIXTURE_SKILL =
  "---\nname: selfcheck-widget\ndescription: Report the status of the widget subsystem. " +
  "Only this skill knows how.\nmodel: small\n---\n\n" +
  "When asked about the widget subsystem, reply with exactly: WIDGET-OK\n";
const SKILL_PROBE = "what is the status of the widget subsystem";

type CheckResult = [ok: boolean, detail: string];
type CheckFn = () => Promise<CheckResult> | CheckResult;

function pad(name: string): string {
  return name.length >= 34 ? name : name + " ".repeat(34 - name.length);
}
function fmtSeconds(n: number): string {
  const s = n.toFixed(1) + "s";
  return s.length >= 7 ? s : " ".repeat(7 - s.length) + s;
}

export async function selfCheck(): Promise<void> {
  // Same env resolution as cli.ts -- shared via desiredModels() precisely so
  // the two entry points can't disagree about which model was asked for.
  const { main, small } = desiredModels(process.env);
  const { client, mainModel, smallModel } = await makeClient(main, small, process.env);
  withRetries(client, { onRetry: printRetrying });
  withDirectNodes(client, loadDirectNodes(process.env), { onStateChange: printDirectNodeState });
  const startedAll = Date.now();
  const results: boolean[] = [];

  console.log();
  console.log(chalk.bold.whiteBright("  eds tui self-check"));
  console.log(chalk.dim(`  main: ${displayModel(mainModel)}    small: ${displayModel(smallModel)}`));
  console.log();

  async function check(name: string, fn: CheckFn): Promise<void> {
    const started = Date.now();
    let ok: boolean;
    let detail: string;
    try {
      [ok, detail] = await fn();
    } catch (e) {
      ok = false;
      detail = e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e);
    }
    results.push(ok);
    const mark = ok ? chalk.bold.green("  ✓ ") : chalk.bold.red("  ✗ ");
    const nameStyled = ok ? chalk.white(pad(name)) : chalk.red(pad(name));
    const time = chalk.dim(fmtSeconds((Date.now() - started) / 1000));
    let line = mark + nameStyled + time;
    if (detail) line += (ok ? chalk.dim(`   ${detail}`) : chalk.red(`   ${detail}`));
    console.log(line);
  }

  const triageFn: TriageFn = (input) => triage(client, input, mainModel, smallModel);

  function baseDeps(overrides: Partial<AgenticLoopDeps> = {}): AgenticLoopDeps {
    return {
      client,
      mainModel,
      smallModel,
      cwd: process.cwd(),
      delegateTask: makeDelegateTask(smallModel, process.cwd(), process.cwd()),
      delegateTaskMain: makeDelegateTask(mainModel, process.cwd(), process.cwd()),
      consultSpecialist: makeConsultSpecialist([], smallModel, process.cwd(), process.cwd()),
      saveHistory: () => {},
      ...overrides,
    };
  }

  async function modelsPresent(): Promise<CheckResult> {
    const list = await client.list();
    const names = new Set(list.models.map((m) => m.model));
    const missing = [mainModel, smallModel].filter((m) => !names.has(m));
    return [missing.length === 0, missing.length === 0 ? "both served" : `missing: ${missing.join(", ")}`];
  }

  async function triageSimple(): Promise<CheckResult> {
    const { model } = await triage(client, SIMPLE_PROBE, mainModel, smallModel);
    return [model === smallModel, `→ ${displayModel(model)}`];
  }

  async function triageComplex(): Promise<CheckResult> {
    const { model } = await triage(client, COMPLEX_PROBE, mainModel, smallModel);
    return [model === mainModel, `→ ${displayModel(model)}`];
  }

  async function fastForcesSmall(): Promise<CheckResult> {
    const { model } = await resolveModel(COMPLEX_PROBE, triageFn, { main: mainModel, small: smallModel }, {
      forceFast: true,
    });
    return [model === smallModel, `→ ${displayModel(model)}`];
  }

  async function smartForcesMain(): Promise<CheckResult> {
    const { model } = await resolveModel(SIMPLE_PROBE, triageFn, { main: mainModel, small: smallModel }, {
      forceSmart: true,
    });
    return [model === mainModel, `→ ${displayModel(model)}`];
  }

  async function delegationWorks(): Promise<CheckResult> {
    console.log();
    const messages: Message[] = [
      { role: "system", content: buildSystemPrompt({ cwd: process.cwd(), appDir: process.cwd(), hardMaxTurns: HARD_MAX_TURNS, activeModel: mainModel, mainModel }) },
      { role: "user", content: DELEGATION_PROBE },
    ];
    const stats: any = {};
    await agenticLoop(baseDeps(), messages, mainModel, stats);
    const n = stats.delegations ?? 0;
    return [n >= 1, `${displayModel(mainModel)} spawned ${displayModel(smallModel)} ×${n}`];
  }

  async function escalationFires(): Promise<CheckResult> {
    console.log();
    const messages: Message[] = [
      { role: "system", content: buildSystemPrompt({ cwd: process.cwd(), appDir: process.cwd(), hardMaxTurns: HARD_MAX_TURNS, activeModel: smallModel, mainModel }) },
      { role: "user", content: ESCALATION_PROBE },
    ];
    const stats: any = {};
    await agenticLoop(baseDeps({ smallMaxTurns: 1 }), messages, smallModel, stats);
    return [Boolean(stats.escalated), `turn cap 1 → ${displayModel(stats.model)} after ${stats.turns} turns`];
  }

  async function capStillAnswers(): Promise<CheckResult> {
    console.log();
    const messages: Message[] = [
      { role: "system", content: buildSystemPrompt({ cwd: process.cwd(), appDir: process.cwd(), hardMaxTurns: HARD_MAX_TURNS, activeModel: mainModel, mainModel }) },
      { role: "user", content: "List the files in the current directory and tell me what you see." },
    ];
    const stats: any = {};
    const answer = await agenticLoop(baseDeps({ hardMaxTurns: 1 }), messages, mainModel, stats);
    const ok = Boolean(answer) && Boolean(stats.capped);
    return [ok, ok ? `capped at 1 round → ${(answer ?? "").length}-char answer` : "capped run returned no answer"];
  }

  async function specialistEscalationFires(): Promise<CheckResult> {
    console.log();
    const messages: Message[] = [
      { role: "system", content: buildSystemPrompt({ cwd: process.cwd(), appDir: process.cwd(), hardMaxTurns: HARD_MAX_TURNS, activeModel: mainModel, mainModel }) },
      { role: "user", content: SPECIALIST_PROBE },
    ];
    const stats: any = {};
    await agenticLoop(baseDeps({ hardMaxTurns: 1, modelPool: SPECIALIST_FIXTURE_POOL }), messages, mainModel, stats);
    return [Boolean(stats.specialistModel), `hard cap 1 → escalated to ${stats.specialistModel ? displayModel(stats.specialistModel) : "(none)"}`];
  }

  async function consultSpecialistWorks(): Promise<CheckResult> {
    console.log();
    const messages: Message[] = [
      { role: "system", content: buildSystemPrompt({ cwd: process.cwd(), appDir: process.cwd(), hardMaxTurns: HARD_MAX_TURNS, activeModel: mainModel, mainModel }) },
      { role: "user", content: CONSULT_PROBE },
    ];
    const stats: any = {};
    await agenticLoop(
      baseDeps({
        modelPool: CONSULT_FIXTURE_POOL,
        consultSpecialist: makeConsultSpecialist(CONSULT_FIXTURE_POOL, smallModel, process.cwd(), process.cwd()),
      }),
      messages,
      mainModel,
      stats
    );
    // Both must hold: the tool was actually reached for, AND control
    // returned to main afterward — the second is the actual proof this is
    // NOT a full hand-off, unlike tier-3 escalation.
    const ok = (stats.consultations ?? 0) >= 1 && stats.model === mainModel;
    return [
      ok,
      `consultations=${stats.consultations ?? 0}, ended on ${displayModel(stats.model)} (main=${displayModel(mainModel)})`,
    ];
  }

  async function repeatCommandIsCached(): Promise<CheckResult> {
    const seen = new Map<string, string>();
    const first = await runCommandOnce("echo cache-probe", process.cwd(), seen);
    const second = await runCommandOnce("echo cache-probe", process.cwd(), seen);
    const ok = first.includes("cache-probe") && second.includes("already ran earlier") && seen.size === 1;
    return [ok, "second identical command replayed, not re-executed"];
  }

  function hugeOutputIsClipped(): CheckResult {
    const big = "x".repeat(500_000);
    const clipped = clipOutput(big);
    const ok = clipped.length < MAX_OUTPUT_CHARS + 500 && clipped.includes("characters cut");
    return [ok, `500,000 chars → ${clipped.length.toLocaleString("en-US")} with a note to narrow the search`];
  }

  async function badSmallModelFallsBack(): Promise<CheckResult> {
    const { model } = await triage(client, SIMPLE_PROBE, mainModel, "does-not-exist:1b");
    return [model === mainModel, `→ ${displayModel(model)}`];
  }

  async function withFixtureSkills<T>(fn: () => Promise<T>): Promise<T> {
    const tmp = mkdtempSync(join(tmpdir(), "eds-tui-selfcheck-"));
    const real = skills.SKILLS_DIR;
    try {
      const directory = join(tmp, "selfcheck-widget");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "SKILL.md"), FIXTURE_SKILL);
      skills.setSkillsDir(tmp);
      return await fn();
    } finally {
      skills.setSkillsDir(real);
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  function skillsParse(): Promise<CheckResult> {
    return withFixtureSkills(async () => {
      const found = skills.discover();
      const skill = found.get("selfcheck-widget");
      if (!skill) return [false, `fixture not discovered (${[...found.keys()].join(", ")})`];
      const ok = skill.model === "small" && skill.body.includes("WIDGET-OK");
      return [ok, "name, description, model and body round-tripped"];
    });
  }

  function skillsTriageMatches(): Promise<CheckResult> {
    return withFixtureSkills(async () => {
      const { skill } = await triage(client, SKILL_PROBE, mainModel, smallModel);
      return [Boolean(skill && skill.name === "selfcheck-widget"), `→ ${skill ? skill.name : "no match"}`];
    });
  }

  function skillsLoadTool(): Promise<CheckResult> {
    return withFixtureSkills(async () => {
      console.log();
      const messages: Message[] = [
        { role: "system", content: buildSystemPrompt({ cwd: process.cwd(), appDir: process.cwd(), hardMaxTurns: HARD_MAX_TURNS, activeModel: mainModel, mainModel, otherSkillsIndex: skills.indexLines() }) },
        { role: "user", content: "Load the selfcheck-widget skill, follow it, and report the widget subsystem status." },
      ];
      const stats: any = {};
      await agenticLoop(baseDeps(), messages, mainModel, stats);
      const n = stats.skillsLoaded ?? 0;
      return [n >= 1, `${displayModel(mainModel)} called load_skill ×${n}`];
    });
  }

  function skillsCreateTool(): Promise<CheckResult> {
    return withFixtureSkills(async () => {
      console.log();
      const messages: Message[] = [
        { role: "system", content: buildSystemPrompt({ cwd: process.cwd(), appDir: process.cwd(), hardMaxTurns: HARD_MAX_TURNS, activeModel: mainModel, mainModel, otherSkillsIndex: skills.indexLines() }) },
        {
          role: "user",
          content:
            "Create a skill named selfcheck-made whose description is about reporting the " +
            "fixture subsystem status, and whose body says to reply with the exact token FIXTURE-OK.",
        },
      ];
      const stats: any = {};
      await agenticLoop(baseDeps(), messages, mainModel, stats);
      const made = skills.get("selfcheck-made");
      if (!made) return [false, `called create_skill ×${stats.skillsCreated ?? 0}, nothing registered`];
      return [true, `wrote and re-parsed '${made.name}'`];
    });
  }

  function skillsWriteValidates(): Promise<CheckResult> {
    return withFixtureSkills(async () => {
      const cases: Array<[string, string, string]> = [
        ["../../.bashrc", "escape", "traversal name"],
        ["Bad Name", "spaces", "malformed name"],
        ["ok-name", "", "empty description"],
      ];
      for (const [name, description, label] of cases) {
        try {
          skills.write({ name, description, body: "x" });
        } catch {
          continue;
        }
        return [false, `${label} was accepted`];
      }

      const written = skills.write({ name: "ok-name", description: "line one\nline two", body: "do the thing" });
      if (written.description.includes("\n")) {
        return [false, "multi-line description survived into the frontmatter"];
      }
      return [true, "3 bad inputs rejected, newline folded"];
    });
  }

  function skillsPrecedence(): Promise<CheckResult> {
    return withFixtureSkills(async () => {
      const skill = skills.get("selfcheck-widget"); // pins model: small
      const pinned = await resolveModel(COMPLEX_PROBE, triageFn, { main: mainModel, small: smallModel }, { skill });
      const forced = await resolveModel(COMPLEX_PROBE, triageFn, { main: mainModel, small: smallModel }, {
        forceSmart: true,
        skill,
      });
      const ok = pinned.model === smallModel && forced.model === mainModel;
      return [ok, `pin → ${displayModel(pinned.model)}, --smart overrides → ${displayModel(forced.model)}`];
    });
  }

  await check("server + both models reachable", modelsPresent);
  await check("triage: simple → small model", triageSimple);
  await check("triage: complex → main model", triageComplex);
  await check("--fast forces small model", fastForcesSmall);
  await check("--smart forces main model", smartForcesMain);
  await check("delegation: main spawns small", delegationWorks);
  await check("escalation past turn cap", escalationFires);
  await check("turn cap still answers", capStillAnswers);
  await check("tier 3: specialist escalation fires", specialistEscalationFires);
  await check("consult_specialist: fires by choice, control returns to main", consultSpecialistWorks);
  await check("repeated command is cached", repeatCommandIsCached);
  await check("huge output is clipped", () => hugeOutputIsClipped());
  await check("bad small model falls back", badSmallModelFallsBack);
  await check("skills: discovered and parsed", skillsParse);
  await check("skills: triage matches a skill", skillsTriageMatches);
  await check("skills: load_skill returns body", skillsLoadTool);
  await check("skills: create_skill writes+parses", skillsCreateTool);
  await check("skills: write rejects bad input", skillsWriteValidates);
  await check("skills: /name pin vs flag", skillsPrecedence);

  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log();
  const totalTime = ((Date.now() - startedAll) / 1000).toFixed(1) + "s";
  const totalTimePadded = totalTime.length >= 19 ? totalTime : " ".repeat(19 - totalTime.length) + totalTime;
  console.log(
    "  " + chalk.bold.green(`${passed} passed`) + "  " + (failed ? chalk.bold.red(`${failed} failed`) : chalk.dim("0 failed")) + chalk.dim(totalTimePadded)
  );
  console.log();
  process.exit(failed ? 1 : 0);
}
