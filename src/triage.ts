// Ported from eds_tui/main.py's classify_complexity()/match_skill()/triage().
//
// The two questions (which model owns this request, and which skill
// applies) are asked in SEPARATE calls on purpose — asking the small model
// for a complexity verdict and a skill name in one reply measured 4/10 on a
// fixture set in the Python original (it answers one question and falls
// back to the first skill in the list for the other); asked separately it
// measured 12/12. Do not combine them.

import type { Ollama } from "ollama";
import * as skills from "./skills.js";
import type { TriageResult } from "./resolve-model.js";

const TRIAGE_SYSTEM =
  "You route requests for a terminal assistant. Reply with exactly one word: SIMPLE or COMPLEX.\n" +
  "SIMPLE = answerable directly or with one or two straightforward shell commands " +
  "(lookups, listing files, checking status, short factual questions, a single command).\n" +
  "COMPLEX = needs multi-step reasoning, writing or refactoring code, debugging, planning, " +
  "chaining many commands, or careful judgement.\n" +
  "Output only that one word.";

function skillMatchSystem(index: string): string {
  return (
    "You match a user's request to a skill for a terminal assistant.\n" +
    "Reply with exactly one word: the name of the skill below whose description covers " +
    "the request, or NONE if none of them do.\n" +
    `Skills:\n${index}\n` +
    "Output only that one word."
  );
}

/** Which model should own this request. Falls back to the main model on any doubt. */
export async function classifyComplexity(
  client: Ollama,
  userInput: string,
  mainModel: string,
  smallModel: string
): Promise<string> {
  // No separate small model configured — nothing to route between.
  if (smallModel === mainModel) return mainModel;
  let verdict: string;
  try {
    const response = await client.chat({
      model: smallModel,
      messages: [
        { role: "system", content: TRIAGE_SYSTEM },
        { role: "user", content: userInput },
      ],
      think: false,
      options: { temperature: 0, num_predict: 8 },
    });
    verdict = (response.message.content ?? "").toUpperCase();
  } catch {
    // Triage must never block the request; when in doubt use the main model.
    return mainModel;
  }

  // The small model wraps its verdict in whatever punctuation it feels like,
  // and sometimes echoes the whole instruction back. Both words present
  // means it did not actually decide, so fail closed to the main model.
  if (verdict.includes("SIMPLE") && !verdict.includes("COMPLEX")) {
    return smallModel;
  }
  return mainModel;
}

/** Which skill covers this request, if any. */
export async function matchSkill(
  client: Ollama,
  userInput: string,
  smallModel: string
): Promise<ReturnType<typeof skills.match>> {
  const index = skills.indexLines();
  if (!index) return null;

  try {
    const response = await client.chat({
      model: smallModel,
      messages: [
        { role: "system", content: skillMatchSystem(index) },
        { role: "user", content: userInput },
      ],
      think: false,
      options: { temperature: 0, num_predict: 12 },
    });
    // Only real names match, so a hallucinated skill reads as no skill at all.
    return skills.match(response.message.content);
  } catch {
    return null; // no skill is always a safe answer
  }
}

/**
 * Route a request: which model owns it, and which skill applies.
 *
 * The two questions run concurrently (Promise.all — Node's async model
 * makes this simpler than the Python original's ThreadPoolExecutor), so
 * installing skills costs an extra round trip but almost no extra
 * wall-clock, and the complexity verdict stays exactly what it would have
 * been with no skills installed.
 */
export async function triage(
  client: Ollama,
  userInput: string,
  mainModel: string,
  smallModel: string
): Promise<TriageResult> {
  if (skills.discover().size === 0) {
    const model = await classifyComplexity(client, userInput, mainModel, smallModel);
    return { model, skill: null };
  }

  const [model, skill] = await Promise.all([
    classifyComplexity(client, userInput, mainModel, smallModel),
    matchSkill(client, userInput, smallModel),
  ]);
  return { model, skill };
}
