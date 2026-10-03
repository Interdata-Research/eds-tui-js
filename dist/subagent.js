// Ported from eds_tui/main.py's build_subagent_prompt()/delegate_task().
//
// Structurally similar to agent.ts's own loop (chat → dispatch tool_calls →
// repeat), but genuinely a separate, smaller loop, not a call into
// agenticLoop() itself: a bounded SUBAGENT_MAX_TURNS=5, shell-only tools, no
// delegation of its own, no view of the parent conversation — the task
// string is its entire brief. Two behaviors deliberately differ from the
// main loop and must NOT be "fixed" to match it:
//   - ANY exception during a sub-agent chat call bails out immediately with
//     "Delegation failed: ... Handle this subtask yourself." — there is
//     nowhere to escalate TO (the sub-agent already IS the small model).
//   - A cached repeated command here returns its substitute note SILENTLY
//     (no command echo, no "already run" console line) — unlike the main
//     loop's run_command_once, which always echoes the command first. This
//     is why subagent.ts does NOT reuse exec.ts's runCommandOnce: the
//     console output differs, not just the returned text.
import { describeError } from "./retry.js";
import { runCommand } from "./exec.js";
import { SHELL_TOOLS } from "./tools.js";
import { FINAL_ANSWER_NUDGE } from "./agent.js";
import * as ui from "./ui.js";
export const SUBAGENT_MAX_TURNS = 5;
const SUB_INDENT = "     ";
export function buildSubagentPrompt(cwd, appDir) {
    return ("You are a focused helper for 'eds tui', a terminal assistant invoked as 'ask', " +
        "running on Ubuntu Linux. " +
        `The current working directory is: ${cwd}. ` +
        // Structurally forced to diverge from the Python wording (which names
        // main.py directly) — see prompt-builder.ts's identical adaptation.
        `The assistant's own source code is the package at ${appDir} (cli.ts is the entry ` +
        "point) — read it if the subtask is about how 'ask' itself behaves, rather than " +
        "guessing from the working directory. " +
        "You have been handed one specific subtask. Use the run_command tool to complete it, " +
        "then report what you found plainly and concisely. " +
        "You are working autonomously — nobody can answer questions, so do not ask any. " +
        "Suppress permission errors with '2>/dev/null'.");
}
/**
 * Build a delegateTask function bound to this node's small model / cwd /
 * self-location, matching AgenticLoopDeps.delegateTask's (client, task)
 * signature so it can be wired straight into agent.ts's deps.
 */
export function makeDelegateTask(smallModel, cwd, appDir) {
    return async (client, task) => {
        ui.printSubagentLabel(smallModel, task);
        const messages = [
            { role: "system", content: buildSubagentPrompt(cwd, appDir) },
            { role: "user", content: task },
        ];
        const seen = new Map();
        for (let i = 0; i < SUBAGENT_MAX_TURNS; i++) {
            let response;
            try {
                response = await ui.withSpinner(`${SUB_INDENT}${ui.displayModel(smallModel)} working...`, () => client.chat({ model: smallModel, messages, tools: SHELL_TOOLS }));
            }
            catch (e) {
                const message = describeError(e);
                ui.printSubagentFailure(message);
                return `Delegation failed: ${message}. Handle this subtask yourself.`;
            }
            const msg = response.message;
            messages.push(msg);
            if (msg.tool_calls && msg.tool_calls.length > 0) {
                for (const tc of msg.tool_calls) {
                    const command = String(tc.function.arguments?.command ?? "").trim();
                    let output;
                    if (seen.has(command)) {
                        output =
                            `Already run in this subtask, output was:\n${seen.get(command)}\n\n` +
                                "Try something different or report what you have.";
                    }
                    else {
                        output = await runCommand(command, cwd, SUB_INDENT);
                        seen.set(command, output);
                    }
                    messages.push({ role: "tool", content: output });
                }
            }
            else {
                const result = (msg.content ?? "").trim() || "(no result)";
                const lines = result.split("\n");
                const rendered = [`${SUB_INDENT}→ ${lines[0]}`, ...lines.slice(1).map((l) => `${SUB_INDENT}  ${l}`)].join("\n");
                ui.printSubagentResult(rendered);
                return result;
            }
        }
        // Same fix as the main loop: rather than handing the parent an apology
        // and making it redo the work, ask for a conclusion with tools removed.
        let result = "";
        try {
            const response = await ui.withSpinner(`${SUB_INDENT}${ui.displayModel(smallModel)} wrapping up...`, () => client.chat({
                model: smallModel,
                messages: [...messages, { role: "user", content: FINAL_ANSWER_NUDGE }],
            }));
            result = (response.message.content ?? "").trim();
        }
        catch {
            result = "";
        }
        if (!result) {
            return (`The subtask hit its ${SUBAGENT_MAX_TURNS}-step limit without a conclusive ` +
                "answer. Handle it yourself if you still need it.");
        }
        ui.printSubagentResult(`${SUB_INDENT}→ ${result.split("\n")[0]}`);
        return (`(subtask hit its ${SUBAGENT_MAX_TURNS}-step limit; this is its best ` +
            `conclusion from what it saw)\n${result}`);
    };
}
//# sourceMappingURL=subagent.js.map