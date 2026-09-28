import { test } from "node:test";
import assert from "node:assert/strict";
import { pinFor, resolveModel, type TriageFn } from "./resolve-model.js";
import type { Skill } from "./types.js";

const MODELS = { main: "qwen3.8:latest", small: "tiny:1b" };

function makeSkill(model: Skill["model"]): Skill {
  return { name: "selfcheck-widget", description: "x", model, body: "x", dir: "/tmp/x" };
}

// A triageFn that should never actually be reached in the flag-forced or
// pinned-skill cases below — throws if called, so a wrongly-taken code path
// fails loudly instead of silently returning a plausible-looking answer.
const unreachableTriage: TriageFn = async () => {
  throw new Error("triage should not have been called");
};

test("pinFor: 'main'/'small' pin to the matching model, 'any' pins to nothing", () => {
  assert.equal(pinFor(makeSkill("main"), MODELS), MODELS.main);
  assert.equal(pinFor(makeSkill("small"), MODELS), MODELS.small);
  assert.equal(pinFor(makeSkill("any"), MODELS), null);
  assert.equal(pinFor(null, MODELS), null);
});

test("--fast forces the small model even against a pinning skill", async () => {
  const skill = makeSkill("main");
  const { model } = await resolveModel("anything", unreachableTriage, MODELS, {
    forceFast: true,
    skill,
  });
  assert.equal(model, MODELS.small);
});

test("--smart forces the main model even against a pinning skill", async () => {
  const skill = makeSkill("small");
  const { model } = await resolveModel("anything", unreachableTriage, MODELS, {
    forceSmart: true,
    skill,
  });
  assert.equal(model, MODELS.main);
});

test("a pinning skill (model: small) short-circuits triage entirely", async () => {
  const skill = makeSkill("small");
  const { model, skill: returned } = await resolveModel("anything", unreachableTriage, MODELS, {
    skill,
  });
  assert.equal(model, MODELS.small);
  assert.equal(returned, skill);
});

test("an explicit non-pinning skill (model: any) still calls triage for the complexity verdict, but keeps the original skill, not whatever triage's own skill-matching found", async () => {
  const explicitSkill = makeSkill("any");
  const otherSkillFoundByTriage = makeSkill("main");
  otherSkillFoundByTriage.name = "some-other-skill";
  const triage: TriageFn = async () => ({ model: MODELS.main, skill: otherSkillFoundByTriage });

  const { model, skill } = await resolveModel("anything", triage, MODELS, { skill: explicitSkill });
  assert.equal(model, MODELS.main);
  assert.equal(skill, explicitSkill); // not otherSkillFoundByTriage
});

test("no skill given: triage's own skill match wins, and pins the model if it names one", async () => {
  const matched = makeSkill("small");
  const triage: TriageFn = async () => ({ model: MODELS.main, skill: matched });

  const { model, skill } = await resolveModel("anything", triage, MODELS, {});
  assert.equal(skill, matched);
  assert.equal(model, MODELS.small); // pinned by the matched skill, overriding triage's complexity verdict
});

test("no skill given, and triage finds none: falls back to the plain complexity verdict", async () => {
  const triage: TriageFn = async () => ({ model: MODELS.small, skill: null });

  const { model, skill } = await resolveModel("anything", triage, MODELS, {});
  assert.equal(skill, null);
  assert.equal(model, MODELS.small);
});
