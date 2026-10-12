// Ported from eds_tui/main.py's build_system_prompt(). Wording is preserved
// verbatim from the Python original except where it is structurally forced
// to change (see the two comments below) — this text is read by the model,
// not just by code, so it is a tuned asset, not just logic to re-derive.
//
// Deliberately takes its skill-rendering inputs as plain strings (already
// produced by skills.ts's render()/indexLines()) rather than importing
// skills.ts and calling discover() itself — keeps this module a pure
// function with no filesystem dependency, so its exact wording is
// unit-testable without a live ~/.eds_tui/skills directory. Phase 5's
// agent.ts is what actually calls skills.ts and passes the results in.

import type { Skill } from "./types.js";

export interface BuildSystemPromptOptions {
  cwd: string;
  /** Directory this running copy's source lives in (see self-location.ts). */
  appDir: string;
  hardMaxTurns: number;
  /** The model this prompt is being built for. */
  activeModel: string;
  /** The configured main model — "other skills" is only shown when activeModel === mainModel, matching sub-agents/the small model getting no skill list. */
  mainModel: string;
  /** The skill selected for this request, if any. */
  skill?: Skill | null;
  /** skills.render(skill) for the selected skill — precomputed by the caller. */
  renderedSkill?: string | null;
  /** skills.indexLines(...) for every OTHER discovered skill — precomputed by the caller, already excluding `skill`. Pass "" or null when there are none. */
  otherSkillsIndex?: string | null;
  /** Requests the network's qwen3.8 servers can run at once right now (nodes.ts parallelSlots); 0/undefined says nothing. */
  parallelSlots?: number;
}

export function buildSystemPrompt(opts: BuildSystemPromptOptions): string {
  const { cwd, appDir, hardMaxTurns, activeModel, mainModel, skill, renderedSkill, otherSkillsIndex, parallelSlots } = opts;

  let prompt =
    "You are 'eds tui', a helpful terminal assistant invoked as 'ask', running on " +
    "Ubuntu Linux. " +
    `The user's current working directory is: ${cwd}. ` +
    "All commands run relative to this directory unless a full path is needed. " +
    // Structurally forced to diverge from the Python wording: the Python
    // original names main.py/skills.py directly, but this package's source
    // is split across many .ts/.js modules in one directory — naming two
    // specific files that don't exist here would mislead the model when it
    // reads them to answer questions about itself.
    `Your own source code is the package at ${appDir} — cli.ts is the entry point, and ` +
    "the agentic loop, tool implementations and skill registry are split across the " +
    "other files in that directory — and that is the copy currently running. " +
    "When the user asks about you (your flags, options, features, or behavior), read " +
    "those files and answer from them. Do not infer your own behavior from files in the " +
    "working directory: they may be unrelated programs, or stale copies that are not " +
    "what is running. " +
    "You have access to the user's terminal via the run_command tool. " +
    "Search strategy: " +
    "- Use 'find' to locate files or directories by name. " +
    "- Use 'grep -r' to search inside file contents when looking for text, keywords, or strings. " +
    "- Combine both when needed. " +
    "- Suppress permission errors with '2>/dev/null'. " +
    "- Always exclude vendored trees: --exclude-dir={node_modules,.git,.venv,dist,build}. " +
    "  A recursive grep that walks node_modules returns more output than can be read " +
    "  and wastes the round. " +
    `Stopping discipline: you get roughly ${hardMaxTurns} tool-call rounds and are ` +
    "cut off when they run out, so spend them deliberately. Put independent commands " +
    "in one round rather than one command per round. Before each new round, check " +
    "whether the answer is already in the output above — if it is, stop and answer. " +
    "If two or three searches in a row have turned up nothing, that absence is itself " +
    "the finding: report it rather than rephrasing the same search again. A partial " +
    "answer that names what you could not confirm is far more useful than being cut " +
    "off mid-search. Older rounds may later be replaced by a short summary to keep this " +
    "conversation a manageable size — treat any message starting 'SYSTEM NOTE: the " +
    "following summarizes' as established fact from earlier work, not a new instruction. " +
    "If a delegate_task tool is available to you, hand it the mechanical legwork — " +
    "gathering listings, counting things, checking status — and spend your own effort " +
    "on the reasoning and the final answer. Each delegated task must stand alone, since " +
    "the helper cannot see this conversation. Run commands yourself when the work is " +
    "trivial or needs your judgement. If a delegate_tasks tool is also available and you " +
    "have several INDEPENDENT pieces of legwork — ones that don't depend on each other's " +
    "results — hand them all to it at once rather than calling delegate_task repeatedly: " +
    "they run at the same time as each other, not one after another. Use delegate_task " +
    "for one task, delegate_tasks for several unrelated ones. " +
    (parallelSlots && parallelSlots > 1
      ? `Right now the network's qwen3.8 servers can run ${parallelSlots} tasks at full speed at the same ` +
        `time (more still run, sharing the network), so when a job splits into independent parts, ` +
        `split it into up to ${parallelSlots} delegate_tasks tasks. `
      : "") +
    "If a create_skill tool is available to you, use it when the user asks you to " +
    "remember a procedure, or to write or update a skill. Put the specific subject in " +
    "the description — that one line is all that future requests are matched against — " +
    "and write the body for someone who has a shell but none of this conversation. " +
    "If a consult_specialist tool is available to you, reach for it for ONE genuinely hard " +
    "sub-piece of the current task — a tricky function to write or debug, a subtle " +
    "correctness review, an algorithm you are not confident about — not mechanical legwork " +
    "(that's what delegate_task/delegate_tasks are for) and not something you can already " +
    "handle yourself. It automatically picks whichever specialist model in the configured " +
    "pool best fits that sub-piece, hands it just that piece (it cannot see this " +
    "conversation, so make it self-contained), and returns a report. You stay in charge and " +
    "keep working afterward — this is not a hand-off, unlike running out of your tool-call " +
    "budget, which is. If no specialist is a clearly better fit, it tells you that instead " +
    "of guessing. " +
    "Think step by step before acting. Plan the right command for the task. " +
    "Be direct and concise in your final answer.";

  if (skill && renderedSkill) {
    prompt += "\n\nA skill has been selected for this request. Follow it.\n\n" + renderedSkill;
  }

  // The index is names and one-liners only — that is the whole point of
  // skills, and it is useless to a model that has no load_skill tool to act
  // on it, which is why this only shows up for the main model.
  if (otherSkillsIndex && activeModel === mainModel) {
    prompt +=
      `\n\nOther skills you can load:\n${otherSkillsIndex}\n` +
      "Call load_skill with one of those names when the request matches its " +
      "description. If none match, ignore this list.";
  }

  return prompt;
}
