// Ported 1:1 from eds_tui/main.py's RUN_COMMAND_TOOL / DELEGATE_TOOL /
// LOAD_SKILL_TOOL / CREATE_SKILL_TOOL — same names, descriptions and JSON
// schemas, since these strings are read by the model, not just by code.
export const RUN_COMMAND_TOOL = {
    type: "function",
    function: {
        name: "run_command",
        description: "Execute a shell command in the user's terminal and return its output. " +
            "Use this to find files, list directories, check system info, run programs, etc.",
        parameters: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The shell command to execute (e.g. 'find / -name myfile 2>/dev/null')",
                },
            },
            required: ["command"],
        },
    },
};
export const DELEGATE_TOOL = {
    type: "function",
    function: {
        name: "delegate_task",
        description: "Hand a small, self-contained subtask to a faster assistant that has the same shell " +
            "access you do. Use it for mechanical legwork — gathering listings, counting things, " +
            "checking status, reading a value out of a file — so you can stay focused on the " +
            "harder reasoning. It cannot see your conversation, so give it one complete " +
            "instruction. It returns a short text report of what it found. By default it runs " +
            "on the small model; pass model:\"main\" to hand it to the full-capability network " +
            "model instead, for a subtask that needs real reasoning rather than legwork.",
        parameters: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "A complete, self-contained instruction, e.g. 'Count the lines in every " +
                        "*.py file in the current directory and report the totals'",
                },
                model: {
                    type: "string",
                    enum: ["small", "main"],
                    description: "Which assistant runs the subtask. \"small\" (default) for cheap mechanical " +
                        "legwork. \"main\" for a subtask that genuinely needs the full-capability " +
                        "network model's reasoning.",
                },
            },
            required: ["task"],
        },
    },
};
export const DELEGATE_TASKS_TOOL = {
    type: "function",
    function: {
        name: "delegate_tasks",
        description: "Hand SEVERAL independent, self-contained subtasks to faster assistants that run " +
            "at the same time as each other, not one after another — use this instead of " +
            "delegate_task when you have multiple pieces of mechanical legwork that don't " +
            "depend on one another's results (e.g. reviewing several files, checking several " +
            "independent things). Each task gets its own assistant with the same shell access " +
            "you have; none of them can see your conversation or each other, so every task " +
            "must be a complete instruction on its own. Returns each task's report, labeled by " +
            "task number. If you only have ONE task, use delegate_task instead — this tool is " +
            "for genuinely independent work you want done in parallel. By default every task " +
            "runs on the small model; pass model:\"main\" when the tasks need real reasoning " +
            "rather than legwork — firing several at once this way is also how you fan work " +
            "out across the interdata network's own compute, since each concurrent request for " +
            "the same model lands on a different node.",
        parameters: {
            type: "object",
            properties: {
                tasks: {
                    type: "array",
                    items: { type: "string" },
                    description: "Two or more complete, self-contained instructions, each independent of the " +
                        "others, e.g. ['Count the *.py files in src/', 'Count the *.py files in tests/']",
                },
                model: {
                    type: "string",
                    enum: ["small", "main"],
                    description: "Which assistant runs every task in this batch. \"small\" (default) for cheap " +
                        "mechanical legwork. \"main\" for tasks that genuinely need the full-capability " +
                        "network model's reasoning, run in parallel across the network.",
                },
            },
            required: ["tasks"],
        },
    },
};
export const LOAD_SKILL_TOOL = {
    type: "function",
    function: {
        name: "load_skill",
        description: "Load the full instructions for one of the skills listed in your system prompt. " +
            "Use it when the request matches a skill's description and you have not already " +
            "been given that skill's text. Returns the skill's procedure, which you then follow.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "The skill's name, exactly as listed in your system prompt",
                },
            },
            required: ["name"],
        },
    },
};
export const CREATE_SKILL_TOOL = {
    type: "function",
    function: {
        name: "create_skill",
        description: "Save a reusable procedure as a skill, so it is available in later runs without " +
            "the user explaining it again. Use it when the user asks you to remember how to " +
            "do something, or to write or update a skill. The file is written and then " +
            "re-read to confirm it registers, and you are told either way.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: "Short lowercase identifier, e.g. 'git-cleanup'. Letters, digits, " +
                        "dots, dashes and underscores only.",
                },
                description: {
                    type: "string",
                    description: "One line saying when to reach for this skill. This is the only text " +
                        "matched against future requests, so name the specific subject rather " +
                        "than describing it in general terms.",
                },
                body: {
                    type: "string",
                    description: "The procedure itself, in Markdown. Write it for someone who has a " +
                        "shell but was not part of this conversation.",
                },
                model: {
                    type: "string",
                    description: "Which model should run it: 'main' for reasoning-heavy work, 'small' " +
                        "for mechanical work, 'any' to let triage decide. Defaults to 'any'.",
                },
                overwrite: {
                    type: "boolean",
                    description: "Set true to replace a skill that already exists.",
                },
            },
            required: ["name", "description", "body"],
        },
    },
};
export const CONSULT_SPECIALIST_TOOL = {
    type: "function",
    function: {
        name: "consult_specialist",
        description: "Get a second opinion or hand off ONE genuinely hard sub-piece of the current task — " +
            "a tricky function to write or debug, a subtle correctness review of a diff, a gnarly " +
            "algorithm — to whichever configured specialist model best fits it, then use its report " +
            "and CONTINUE the overall task yourself. This does not hand off control the way running " +
            "out of turns does. The specialist is picked automatically from the configured pool " +
            "based on what the sub-piece needs; it has the same shell access you do, but cannot see " +
            "this conversation, so give it one complete, self-contained sub-piece — not the whole " +
            "task, and not something simple delegate_task could already handle. If no specialist in " +
            "the pool is a clearly better fit than you already are, it says so instead of guessing.",
        parameters: {
            type: "object",
            properties: {
                task: {
                    type: "string",
                    description: "The one hard sub-piece to hand off, as a complete, self-contained instruction " +
                        "with all the context it needs (relevant file paths, the exact function or bug, " +
                        "what 'correct' means here) — e.g. 'In src/parser.ts, the tokenize() function " +
                        "mishandles nested quotes; find and fix the bug, then show the corrected function.'",
                },
            },
            required: ["task"],
        },
    },
};
// Sub-agent and small model: shell only. Mirrors SHELL_TOOLS in main.py.
export const SHELL_TOOLS = [RUN_COMMAND_TOOL];
//# sourceMappingURL=tools.js.map