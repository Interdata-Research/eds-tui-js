// The `consult_specialist` tool: lets the main model (or a tier-3 specialist
// standing in for it) proactively hand off ONE hard sub-piece of the
// current task — not the whole session — to whichever configured pool
// entry best fits it, get a report back, and keep working the rest of the
// task itself. Deliberately distinct from tryEscalateToSpecialist in
// agent.ts (tier-3): that only fires mechanically, once per run, when the
// main model has already exhausted its whole turn budget or its request
// threw, and hands off control of the ENTIRE remaining session. This fires
// by the model's own choice, any number of times, and control always
// returns to the caller.
//
// Structurally mirrors subagent.ts's bounded sub-loop (shell-only tools, no
// view of the parent conversation, same salvage-on-exhaustion pattern via
// FINAL_ANSWER_NUDGE) — but the model running the loop is picked per call
// from the pool via pickSpecialistModel, not a fixed smallModel.
import { describeError } from "./retry.js";
import { runCommand } from "./exec.js";
import { SHELL_TOOLS } from "./tools.js";
import { FINAL_ANSWER_NUDGE } from "./agent.js";
import { pickSpecialistModel } from "./model-pool.js";
import * as ui from "./ui.js";
export const CONSULT_MAX_TURNS = 8;
const CONSULT_INDENT = "     ";
export function buildConsultPrompt(cwd, appDir) {
    return ("You are being consulted by another AI assistant for 'eds tui', a terminal assistant " +
        "invoked as 'ask', running on Ubuntu Linux, as a specialist for ONE hard sub-piece of a " +
        "larger task it is still handling itself. " +
        `The current working directory is: ${cwd}. ` +
        `The assistant's own source code is the package at ${appDir} (cli.ts is the entry ` +
        "point) — read it if the sub-piece is about how 'ask' itself behaves, rather than " +
        "guessing from the working directory. " +
        "Use the run_command tool to do whatever the sub-piece actually needs, then report your " +
        "conclusion — the code, the fix, the answer — plainly and concisely. " +
        "You are working autonomously — nobody can answer questions, so do not ask any. " +
        "Suppress permission errors with '2>/dev/null'.");
}
/**
 * Build a consultSpecialist function bound to this node's pool / small model
 * (used only for routing the pick, matching tier-3's own pickSpecialistModel
 * usage) / cwd / self-location, matching AgenticLoopDeps.consultSpecialist's
 * (client, task) signature so it can be wired straight into agent.ts's deps.
 */
export function makeConsultSpecialist(pool, smallModel, cwd, appDir) {
    return async (client, task) => {
        if (pool.length === 0) {
            return "No specialist pool is configured. Handle this yourself.";
        }
        // Matched against THIS sub-task's text, not the whole original request
        // — the one deliberate difference from tier-3's tryEscalateToSpecialist,
        // which matches against the original request because it is picking a
        // specialist for the entire remaining session, not one specific piece.
        const specialist = await pickSpecialistModel(client, task, pool, smallModel);
        if (!specialist) {
            return "No specialist in the pool is a clearly better fit for this than you already are. Handle it yourself.";
        }
        ui.printConsultLabel(specialist, task);
        const messages = [
            { role: "system", content: buildConsultPrompt(cwd, appDir) },
            { role: "user", content: task },
        ];
        const seen = new Map();
        for (let i = 0; i < CONSULT_MAX_TURNS; i++) {
            let response;
            try {
                response = await ui.withSpinner(`${CONSULT_INDENT}${ui.displayModel(specialist)} working...`, () => client.chat({ model: specialist, messages, tools: SHELL_TOOLS }));
            }
            catch (e) {
                const message = describeError(e);
                ui.printConsultFailure(message);
                return `Consult with ${specialist} failed: ${message}. There is nowhere further to escalate this to — handle it yourself.`;
            }
            const msg = response.message;
            messages.push(msg);
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    const command = String(tc.function.arguments?.command ?? "").trim();
                    let output;
                    if (seen.has(command)) {
                        output =
                            `Already run in this consult, output was:\n${seen.get(command)}\n\n` +
                                "Try something different or report what you have.";
                    }
                    else {
                        output = await runCommand(command, cwd, CONSULT_INDENT);
                        seen.set(command, output);
                    }
                    messages.push({ role: "tool", content: output });
                }
            }
            else {
                const result = (msg.content ?? "").trim() || "(no result)";
                const lines = result.split("\n");
                const rendered = [`${CONSULT_INDENT}→ ${lines[0]}`, ...lines.slice(1).map((l) => `${CONSULT_INDENT}  ${l}`)].join("\n");
                ui.printConsultResult(rendered);
                return `Consultation with ${specialist} concluded:\n${result}`;
            }
        }
        let result = "";
        try {
            const response = await ui.withSpinner(`${CONSULT_INDENT}${ui.displayModel(specialist)} wrapping up...`, () => client.chat({
                model: specialist,
                messages: [...messages, { role: "user", content: FINAL_ANSWER_NUDGE }],
            }));
            result = (response.message.content ?? "").trim();
        }
        catch {
            result = "";
        }
        if (!result) {
            return (`The consult with ${specialist} hit its ${CONSULT_MAX_TURNS}-step limit without a ` +
                "conclusive answer. Handle it yourself if you still need it.");
        }
        ui.printConsultResult(`${CONSULT_INDENT}→ ${result.split("\n")[0]}`);
        return (`Consultation with ${specialist} concluded (hit its ${CONSULT_MAX_TURNS}-step limit; ` +
            `this is its best conclusion from what it saw):\n${result}`);
    };
}
//# sourceMappingURL=consult.js.map