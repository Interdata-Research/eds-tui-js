// Ported from eds_tui/main.py's agentic_loop()/final_answer()/tools_for()/
// load_skill()/create_skill(), line-by-line against the Python source — this
// is the highest-risk module in the whole port (turn-budget/escalation
// state machine), so nothing here was re-derived from prose.
//
// Two turn-budget subtleties that are easy to get wrong and MUST be
// preserved exactly (confirmed by re-reading main.py:817-936 directly):
//   1. HARD_MAX_TURNS/SMALL_MAX_TURNS are checked against `turns` (the
//      ACTIVE model's own counter), never `total` (the whole-run counter,
//      which only feeds `stats.turns` for observability and never gates
//      anything).
//   2. Escalating because the small model ran out of its own turn budget
//      DOES reset `turns` to 1 (the newly-active main model gets a full
//      fresh budget for the very same loop iteration). Escalating because
//      the small model's own chat() call THREW does NOT reset `turns` —
//      it keeps counting from wherever it already was. These are two
//      different code paths in the Python original with different reset
//      behavior; conflating them would be a real, subtle bug.

import type { Ollama, Message, Tool } from "ollama";
import * as skills from "./skills.js";
import { runCommandOnce } from "./exec.js";
import {
  RUN_COMMAND_TOOL,
  DELEGATE_TOOL,
  DELEGATE_TASKS_TOOL,
  LOAD_SKILL_TOOL,
  CREATE_SKILL_TOOL,
  CONSULT_SPECIALIST_TOOL,
  SHELL_TOOLS,
} from "./tools.js";
import { maybeCompact } from "./compaction.js";
import type { RunStats } from "./types.js";
import * as ui from "./ui.js";
import { pickSpecialistModel, type PoolEntry } from "./model-pool.js";

export const SMALL_MAX_TURNS = 6; // tool-call rounds before escalating off the small model
export const HARD_MAX_TURNS = 40; // absolute ceiling, prevents a runaway loop

const WRAP_UP_NUDGE = (left: number): string =>
  `SYSTEM NOTE: you have ${left} tool-call round(s) left before you are cut off. ` +
  "Stop widening the search. Run something only if it would change your conclusion; " +
  "otherwise answer now from what you already have, and say which parts you could " +
  "not confirm.";

export const FINAL_ANSWER_NUDGE =
  "You have used the entire tool-call budget for this request. No further commands " +
  "will run. Answer now using only what the commands above already showed you. " +
  "State the best conclusion the evidence supports, and say plainly which parts you " +
  "could not confirm and what you would have checked next. Do not ask to run anything.";

/**
 * The main model (or a tier-3 specialist standing in for it) can delegate,
 * write skills and load them; the small model just runs commands.
 * create_skill is never gated on the registry — it is how the first skill
 * gets written.
 *
 * Checked against smallModel, not mainModel — originally this compared
 * `activeModel !== mainModel`, which was correct back when exactly two
 * models could ever be active. Once tier-3 specialist escalation exists, a
 * third model can be active too, and it should get the SAME (full) tool
 * access main does — it's standing in for main because it has MORE
 * capability for this task, not less. Restricting by "is this the small
 * model" instead of "is this NOT the main model" correctly grants full
 * tools to main and to any specialist alike, and restricts only the one
 * model that should actually be restricted.
 */
export function toolsFor(activeModel: string, smallModel: string, hasSpecialistPool: boolean): Tool[] {
  if (activeModel === smallModel) return SHELL_TOOLS;
  const tools: Tool[] = [RUN_COMMAND_TOOL, DELEGATE_TOOL, DELEGATE_TASKS_TOOL, CREATE_SKILL_TOOL];
  // Gated the same way LOAD_SKILL_TOOL is gated on skills.discover().size > 0
  // — no point offering a tool that can only ever reply "no pool configured".
  if (hasSpecialistPool) tools.push(CONSULT_SPECIALIST_TOOL);
  if (skills.discover().size > 0) tools.push(LOAD_SKILL_TOOL); // nothing installed, nothing to load
  return tools;
}

function loadSkill(name: string): string {
  const skill = skills.get(name);
  ui.printSkillLabel(name, Boolean(skill));

  if (skill) return skills.render(skill);

  const index = skills.indexLines();
  if (!index) return `There is no skill named '${name}', and no skills are installed.`;
  return `There is no skill named '${name}'. The skills that exist are:\n${index}`;
}

function asBool(value: unknown): boolean {
  if (typeof value === "string") {
    return ["true", "yes", "1"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

function createSkill(args: Record<string, any>): string {
  const name = args.name ?? "";
  ui.printCreateSkillLabel(name);

  let skill;
  try {
    skill = skills.write({
      name,
      description: args.description ?? "",
      body: args.body ?? "",
      model: args.model ?? "any",
      overwrite: asBool(args.overwrite ?? false),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ui.printCreateSkillError(message);
    return `create_skill failed: ${message}`;
  }

  const path = `${skill.dir}/SKILL.md`;
  ui.printCreateSkillSuccess(path, skill.name, skill.model);

  return (
    `Saved and verified: ${path} parses back and registers as '${skill.name}' ` +
    `(model ${skill.model}). It is available from the next ask run onward.`
  );
}

/**
 * Which bound delegate function a tool call's optional `model` argument
 * selects — "main" for the network's full-capability model (deps.mainModel,
 * e.g. qwen3.8:latest), anything else (missing, "small", or garbled) for the
 * small model, same default as before this parameter existed.
 */
function pickDelegateFn(deps: AgenticLoopDeps, modelArg: unknown): DelegateTaskFn {
  return modelArg === "main" ? deps.delegateTaskMain : deps.delegateTask;
}

/**
 * Dispatch N independent tasks to N sub-agents CONCURRENTLY (Promise.all,
 * not one after another) and combine their reports. Each call reuses the
 * exact same delegateTask function the single-task path uses — no new
 * sub-agent machinery, just running several instances of the existing one
 * at once. Real parallelism across different physical nodes serving the
 * same model comes for free from the relay's own round-robin backend
 * selection (verified directly against miniaicloud's source): concurrent
 * requests for the same model name land on different registered backends,
 * ask never needs to address a specific node itself. `modelArg` ("small" |
 * "main", from the tool call) picks which model every task in this batch
 * runs on — "main" is how a batch fans out across the network's
 * qwen3.8:latest-class nodes specifically, not just the small model's.
 */
async function delegateTasksInParallel(deps: AgenticLoopDeps, tasks: string[], modelArg?: unknown): Promise<string> {
  if (tasks.length === 0) return "No tasks were given to delegate_tasks.";

  const fn = pickDelegateFn(deps, modelArg);
  ui.printDelegatingTasksHeader(tasks);
  const reports = await Promise.all(tasks.map((task) => fn(deps.client, task)));

  return tasks.map((task, i) => `Task ${i + 1}: ${task}\nResult: ${reports[i]}`).join("\n\n");
}

export type DelegateTaskFn = (client: Ollama, task: string) => Promise<string>;
export type ConsultSpecialistFn = (client: Ollama, task: string) => Promise<string>;
export type SaveHistoryFn = (messages: Message[]) => void;

export interface AgenticLoopDeps {
  client: Ollama;
  mainModel: string;
  smallModel: string;
  cwd: string;
  delegateTask: DelegateTaskFn;
  /**
   * Same shape as delegateTask, bound to mainModel instead of smallModel —
   * picked by pickDelegateFn() when a delegate_task/delegate_tasks call sets
   * model:"main". Always bound (same convention as delegateTask/
   * consultSpecialist below), even though most callers only ever exercise
   * the small-model default.
   */
  delegateTaskMain: DelegateTaskFn;
  /**
   * The consult_specialist tool: a proactive, per-call hand-off of ONE hard
   * sub-piece of the current task to a pool-picked specialist, with control
   * always returning to the caller — distinct from tier-3 escalation below,
   * which is a mechanical, once-per-run, whole-session hand-off. Only
   * offered to the active model at all when a pool is configured (see
   * toolsFor's hasSpecialistPool gate), but always bound here regardless,
   * same as delegateTask always being bound even though it's always used.
   */
  consultSpecialist: ConsultSpecialistFn;
  saveHistory: SaveHistoryFn;
  /**
   * Override the real SMALL_MAX_TURNS/HARD_MAX_TURNS constants for this run
   * only — real callers never set these; they default to the real exported
   * constants. Exists so selftest.ts can force escalation/capping quickly
   * and deterministically without waiting on a real model to naturally
   * burn 6-14 turns. The Python original achieves the same thing by
   * temporarily mutating its module globals (`globals()["SMALL_MAX_TURNS"]
   * = 1`); SMALL_MAX_TURNS/HARD_MAX_TURNS here are real `const` exports
   * (safer for normal use), so this explicit, opt-in seam is the TS
   * equivalent rather than a fragile global-mutation hack.
   */
  smallMaxTurns?: number;
  hardMaxTurns?: number;
  /**
   * Tier-3 specialist models: mainly use mainModel/smallModel as always,
   * but when the main model genuinely exhausts its turn budget without
   * concluding, try escalating once more to whichever pool entry best fits
   * the original request before falling back to finalAnswer on the same
   * model that just struggled. Undefined/empty pool = tier 3 never fires,
   * behavior is identical to before this existed.
   */
  modelPool?: PoolEntry[];
}

/**
 * Make one last call with no tools attached, so the model must answer from
 * the evidence already on the transcript. The nudge itself is not saved to
 * history, only the answer it produces (if any).
 */
export async function finalAnswer(
  deps: AgenticLoopDeps,
  messages: Message[],
  activeModel: string
): Promise<string | null> {
  let response;
  try {
    response = await ui.withSpinner("Wrapping up...", () =>
      deps.client.chat({
        model: activeModel,
        messages: [...messages, { role: "user", content: FINAL_ANSWER_NUDGE }],
      })
    );
  } catch (e) {
    ui.printCouldNotProduceFinalAnswer(e instanceof Error ? e.message : String(e));
    deps.saveHistory(messages);
    return null;
  }

  const content = (response.message.content ?? "").trim();
  if (!content) {
    ui.printStoppedNoAnswer();
    deps.saveHistory(messages);
    return null;
  }

  messages.push(response.message);
  await ui.renderAnswer(content);
  deps.saveHistory(messages);
  return content;
}

export async function agenticLoop(
  deps: AgenticLoopDeps,
  messages: Message[],
  initialActiveModel: string,
  stats: Partial<RunStats> = {}
): Promise<string | null> {
  Object.assign(stats, {
    turns: 0,
    delegations: 0,
    commands: 0,
    skillsLoaded: 0,
    skillsCreated: 0,
    escalated: false,
    capped: false,
    model: initialActiveModel,
    specialistModel: null,
    consultations: 0,
    compactions: 0,
  });

  // Output of every command run this turn-loop, so an identical re-run can
  // be answered from here instead of spending a round to learn nothing.
  const seen = new Map<string, string>();

  const hardMaxTurns = deps.hardMaxTurns ?? HARD_MAX_TURNS;
  const smallMaxTurns = deps.smallMaxTurns ?? SMALL_MAX_TURNS;

  let activeModel = initialActiveModel;
  let turns = 0;
  let total = 0;
  let usedSpecialist = false;

  /**
   * Tier 3: mainly use main/small as always, but when the main model
   * genuinely can't finish, try escalating once more to whichever pool
   * entry best fits the ORIGINAL request (not the growing tool-call
   * transcript) before falling back to a same-model salvage answer.
   * `resetTurns` mirrors the existing tier1->tier2 asymmetry: a
   * turn-budget-exhaustion escalation gets a full fresh budget (matches
   * the small->main count-exhaustion path); an exception-triggered
   * escalation does not (matches the small->main exception path) — see
   * the module-level comment for why that asymmetry exists at all.
   */
  async function tryEscalateToSpecialist(resetTurns: boolean): Promise<boolean> {
    if (activeModel !== deps.mainModel || usedSpecialist) return false;
    const pool = deps.modelPool ?? [];
    if (pool.length === 0) return false;

    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const specialist = await pickSpecialistModel(deps.client, lastUserMessage?.content ?? "", pool, deps.smallModel);
    if (!specialist || specialist === deps.mainModel) return false;

    ui.printEscalatingToSpecialist(specialist);
    activeModel = specialist;
    usedSpecialist = true;
    stats.specialistModel = specialist;
    if (resetTurns) turns = 1;
    return true;
  }

  for (;;) {
    turns += 1;
    total += 1;
    stats.turns = total;

    if (turns > hardMaxTurns) {
      // The ceiling itself was hit — a real, meaningful event regardless
      // of what happens next, so this is set unconditionally (not only in
      // the salvage-failure branch below). A caller can still tell
      // "capped but successfully escalated" apart from "capped and
      // salvaged on the same model" via stats.specialistModel.
      stats.capped = true;
      if (!(await tryEscalateToSpecialist(true))) {
        ui.printBudgetSpent();
        return finalAnswer(deps, messages, activeModel);
      }
      // Escalated — fall through to run the rest of THIS iteration against
      // the new specialist model (turns is already reset to 1 above; no
      // extra increment happens since we don't `continue` back to the loop
      // top).
    }

    if (activeModel === deps.smallModel && turns > smallMaxTurns) {
      ui.printEscalating(deps.mainModel);
      activeModel = deps.mainModel;
      stats.escalated = true;
      // The main model inherits the transcript, not the spent budget.
      turns = 1;
    }

    stats.model = activeModel;

    // Compaction only mutates `messages` (splicing older turns into one
    // summary) — it never touches `turns`/`total`, which are plain local
    // counters already fully decoupled from messages.length. Safe to run
    // right before spending this round on a request.
    if (await maybeCompact(deps.client, deps.smallModel, messages)) {
      stats.compactions = (stats.compactions ?? 0) + 1;
    }

    let response;
    try {
      response = await ui.withSpinner("Thinking...", () =>
        deps.client.chat({
          model: activeModel,
          messages,
          tools: toolsFor(activeModel, deps.smallModel, (deps.modelPool?.length ?? 0) > 0),
        })
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (activeModel === deps.smallModel) {
        ui.printEscalatingOnFailure(deps.smallModel, deps.mainModel, message);
        activeModel = deps.mainModel;
        stats.escalated = true;
        // Deliberately NOT reset here, unlike the turn-budget escalation
        // above — this is a different code path in the Python original
        // with different reset behavior; turns keeps counting.
        continue;
      }
      // A request that fails mid-run used to raise and discard a
      // transcript full of gathered evidence. Try a tier-3 specialist
      // first (only fires when activeModel is still main and none has
      // been used yet — a no-op once we're already on a specialist, or
      // once one has already been tried this run); failing that, try to
      // answer from the transcript so far; only if there is nothing to
      // answer from does the error reach the caller.
      ui.printModelRequestFailed(activeModel, message);
      if (await tryEscalateToSpecialist(false)) {
        continue;
      }
      if (messages.some((m) => m.role === "tool")) {
        stats.capped = true;
        return finalAnswer(deps, messages, activeModel);
      }
      throw e;
    }

    const msg = response.message;
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      ui.printRunningTools();
      for (const tc of msg.tool_calls) {
        const args = tc.function.arguments ?? {};
        let output: string;
        if (tc.function.name === "delegate_task") {
          stats.delegations = (stats.delegations ?? 0) + 1;
          output = await pickDelegateFn(deps, args.model)(deps.client, args.task ?? "");
        } else if (tc.function.name === "delegate_tasks") {
          const tasks: string[] = Array.isArray(args.tasks) ? args.tasks.filter((t: unknown) => typeof t === "string") : [];
          stats.delegations = (stats.delegations ?? 0) + tasks.length;
          output = await delegateTasksInParallel(deps, tasks, args.model);
        } else if (tc.function.name === "consult_specialist") {
          stats.consultations = (stats.consultations ?? 0) + 1;
          output = await deps.consultSpecialist(deps.client, args.task ?? "");
        } else if (tc.function.name === "load_skill") {
          stats.skillsLoaded = (stats.skillsLoaded ?? 0) + 1;
          output = loadSkill(args.name ?? "");
        } else if (tc.function.name === "create_skill") {
          stats.skillsCreated = (stats.skillsCreated ?? 0) + 1;
          output = createSkill(args);
        } else {
          stats.commands = (stats.commands ?? 0) + 1;
          output = await runCommandOnce(args.command ?? "", deps.cwd, seen);
        }
        messages.push({ role: "tool", content: output });
      }

      // Warn before the cap rather than at it. A model that knows it has
      // two rounds left will usually conclude; one that is cut off without
      // notice never gets the chance.
      const left = hardMaxTurns - turns;
      const lastMessage = messages[messages.length - 1];
      if (left > 0 && left <= 2 && lastMessage?.role === "tool") {
        lastMessage.content += "\n\n" + WRAP_UP_NUDGE(left);
      }
    } else {
      await ui.renderAnswer(msg.content);
      deps.saveHistory(messages);
      return msg.content;
    }
  }
}
