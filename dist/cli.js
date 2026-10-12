#!/usr/bin/env node
// Ported from eds_tui/main.py's main() plus its surrounding CLI-level
// helpers (print_skills, scaffold_skill, extract_skill,
// looks_like_a_shell_flag/shell_flag_hint, load_history/save_history/
// clear_history, self_upgrade). This is the actual npm `bin` entry point —
// everything else in this package is composed together here.
import { existsSync, readFileSync, writeFileSync, unlinkSync, realpathSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { makeClient, desiredModels } from "./client.js";
import { triage } from "./triage.js";
import { resolveModel, pinFor } from "./resolve-model.js";
import { withNodeRouting, loadNodeConfig, parallelSlots, probeNode } from "./nodes.js";
import { discoverCached, discoverNodes } from "./discover.js";
import { fileLeases } from "./leases.js";
import { stoppableChat } from "./abort.js";
import { repairAfterStop, runSession } from "./session.js";
import { buildSystemPrompt } from "./prompt-builder.js";
import { agenticLoop, HARD_MAX_TURNS } from "./agent.js";
import { makeDelegateTask } from "./subagent.js";
import { makeConsultSpecialist } from "./consult.js";
import { loadPool } from "./model-pool.js";
import * as skills from "./skills.js";
import * as ui from "./ui.js";
import { promptLine } from "./input.js";
import { selfUpgrade, githubUpgrade } from "./upgrade.js";
// Where this running copy's source actually lives, regardless of the
// user's cwd — resolved through the real installed-package path, not the
// `npm install -g` bin symlink (fs.realpathSync is what makes that work;
// a raw fileURLToPath alone would point at the symlink shim instead).
const APP_DIR = dirname(realpathSync(fileURLToPath(import.meta.url)));
// EDS_TUI_HISTORY_FILE gives one run its own history, so several `ask` processes
// (e.g. the AI Command Center running tasks in parallel) don't clobber each other.
const HISTORY_FILE = process.env.EDS_TUI_HISTORY_FILE || join(homedir(), ".eds_tui_history.json");
function loadHistory() {
    if (existsSync(HISTORY_FILE)) {
        try {
            return JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
        }
        catch {
            return [];
        }
    }
    return [];
}
function normalizeForHistory(messages) {
    return messages
        .filter((m) => m.role !== "system")
        .map((m) => {
        const out = { role: m.role, content: m.content ?? "" };
        if (m.tool_calls && m.tool_calls.length > 0) {
            out.tool_calls = m.tool_calls.map((tc) => ({
                function: { name: tc.function.name, arguments: tc.function.arguments },
            }));
        }
        return out;
    });
}
function saveHistory(messages) {
    writeFileSync(HISTORY_FILE, JSON.stringify(normalizeForHistory(messages)));
}
function clearHistory() {
    if (existsSync(HISTORY_FILE))
        unlinkSync(HISTORY_FILE);
}
function printSkills() {
    const found = skills.discover();
    console.log();
    if (found.size === 0) {
        ui.say("  No skills installed.");
        ui.say(`  They live in ${skills.SKILLS_DIR}`);
        ui.say("  Create one with:  ask --skill-new <name>");
    }
    else {
        console.log(chalk.bold.whiteBright(`  ${found.size} skill(s) in ${skills.SKILLS_DIR}`));
        console.log();
        for (const skill of found.values()) {
            let line = "  " + chalk.bold.cyan(skill.name);
            if (skill.model !== "any")
                line += chalk.dim.yellow(`  [${skill.model} model]`);
            console.log(line);
            console.log(chalk.dim(`      ${skill.description}`));
        }
    }
    const broken = skills.problems();
    if (broken.length > 0) {
        console.log();
        console.log(chalk.bold.red("  Skipped, could not parse:"));
        for (const [entry, reason] of broken) {
            console.log(chalk.red(`    ${entry}: ${reason}`));
        }
    }
    console.log();
}
function scaffoldSkill(name) {
    const directory = join(skills.SKILLS_DIR, name);
    const path = join(directory, "SKILL.md");
    if (existsSync(path)) {
        console.log(chalk.red(`\n  ${path} already exists.\n`));
        process.exit(1);
    }
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, skills.TEMPLATE(name));
    console.log(chalk.green(`\n  Created ${path}`));
    ui.say("  Edit the description first — it is all the model sees until the skill loads.\n");
    process.exit(0);
}
/** The request and the skill a leading "/name" picks; null (after saying so) when no such skill exists. */
function extractSkill(userInput) {
    if (!userInput.startsWith("/"))
        return { request: userInput, skill: null };
    const withoutSlash = userInput.slice(1);
    const spaceIdx = withoutSlash.indexOf(" ");
    const name = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1);
    const skill = skills.get(name);
    if (!skill) {
        console.log(chalk.red(`\n  No skill named '${name}'.`));
        printSkills();
        return null;
    }
    return { request: rest.trim() || `Run the ${skill.name} skill.`, skill };
}
/** More qwen3.8 servers on the network (discover.ts), unless the configuration turns that off. */
function discoverFor(cfg, model) {
    if (!cfg.discover)
        return undefined;
    return discoverCached({ model, configured: [...cfg.direct, ...cfg.lastResort], tokens: cfg.tokens })
        .then((d) => d.urls)
        .catch(() => []);
}
/** `ask --nodes`: the qwen3.8 servers ask spreads work over, looked up fresh, each checked once. */
async function printNodes(model) {
    const cfg = loadNodeConfig(process.env);
    const configured = [...cfg.direct, ...cfg.lastResort];
    const found = cfg.discover
        ? await discoverNodes({ model, configured, tokens: cfg.tokens })
        : { urls: [], duplicates: {} };
    const leases = fileLeases();
    const rows = [
        ...cfg.direct.map((u) => [u, "configured"]),
        ...found.urls.map((u) => [u, "found on the network"]),
        ...cfg.lastResort.map((u) => [u, "last resort (only when the hub fails)"]),
    ];
    console.log();
    console.log(chalk.bold.whiteBright(`  ${model} servers`));
    for (const [url, why] of rows) {
        const started = Date.now();
        const { ok, detail } = await probeNode(url, model, { attempts: 1, timeoutMs: 15_000, token: cfg.tokens?.[url] });
        const state = ok ? chalk.green(`answers (${((Date.now() - started) / 1000).toFixed(1)}s)`) : chalk.red(detail);
        const slots = why.startsWith("last") ? "" : `, ${cfg.slots?.[url] ?? 1} at a time, ${leases.count(url)} running now`;
        console.log(`  ${url}  ${chalk.dim(`${why}${slots}`)}  ${state}`);
    }
    for (const [dup, of] of Object.entries(found.duplicates)) {
        if (!configured.includes(dup))
            console.log(chalk.dim(`  ${dup}  same server as ${of}, not used twice`));
    }
    if (!cfg.discover)
        console.log(chalk.dim("  (looking on the network is off: EDS_TUI_DISCOVER=0, an explicit EDS_TUI_DIRECT_NODES, or \"discover\": false)"));
    console.log(chalk.dim(`  Up to ${parallelSlots(cfg, found.urls)} requests run at once on these; more go to the hub, which spreads them over the network.`));
    console.log();
}
function looksLikeAShellFlag(text) {
    const stripped = text.trim();
    return stripped.startsWith("--") || stripped.startsWith("ask -");
}
function printShellFlagHint(text) {
    const stripped = text.trim();
    const command = stripped.startsWith("ask ") ? stripped : `ask ${stripped}`;
    console.log(chalk.yellow("  That is a command-line flag, not a question."));
    console.log(chalk.dim(`  Run it from your shell instead:  ${command}`));
    console.log();
}
async function main() {
    const argv = process.argv.slice(2);
    // Before anything else: no skill seeding, no network, no TTY needed. This
    // is what an installer probes, so it has to be the cheapest path in here.
    if (argv.includes("--version") || argv.includes("-v")) {
        // APP_DIR is <pkg>/dist, resolved through realpathSync above, so this
        // works through the `npm install -g` bin symlink too. package.json ships
        // in the tarball regardless of the `files` whitelist.
        const pkg = JSON.parse(readFileSync(join(APP_DIR, "..", "package.json"), "utf8"));
        console.log(pkg.version);
        process.exit(0);
    }
    // One-time-only: seeds eds-tui's bundled default skills the first time
    // ~/.eds_tui/skills doesn't exist at all yet. A no-op on every later run,
    // including after a user edits or deletes what was seeded.
    skills.seedDefaultSkills();
    if (argv.includes("--upgrade"))
        selfUpgrade();
    if (argv.includes("--github-upgrade")) {
        const next = argv[argv.indexOf("--github-upgrade") + 1];
        githubUpgrade(next && !next.startsWith("--") ? next : undefined);
    }
    if (argv.includes("--skills")) {
        printSkills();
        process.exit(0);
    }
    if (argv.includes("--skill-new")) {
        const i = argv.indexOf("--skill-new");
        if (i + 1 >= argv.length) {
            console.log(chalk.red("\n  Usage: ask --skill-new <name>\n"));
            process.exit(1);
        }
        scaffoldSkill(argv[i + 1]);
    }
    if (argv.includes("--test")) {
        const { selfCheck } = await import("./selftest.js");
        await selfCheck();
        return;
    }
    if (argv.includes("--login")) {
        const { login } = await import("./login.js");
        await login();
    }
    if (argv.includes("--logout")) {
        const { logout } = await import("./login.js");
        logout();
    }
    if (argv.includes("--whoami")) {
        const { whoami } = await import("./login.js");
        await whoami();
    }
    const isContinue = argv.includes("--continue");
    const forceFast = argv.includes("--fast");
    const forceSmart = argv.includes("--smart");
    // EDS_TUI_MODEL / EDS_TUI_SMALL_MODEL if set, package defaults otherwise.
    const { main, small } = desiredModels(process.env);
    if (argv.includes("--nodes")) {
        await printNodes(main);
        process.exit(0);
    }
    const { client, mainModel, smallModel } = await makeClient(main, small, process.env);
    const nodeConfig = loadNodeConfig(process.env);
    const discovered = discoverFor(nodeConfig, mainModel); // runs while the user types
    withNodeRouting(client, nodeConfig, { retry: { onRetry: ui.printRetrying }, discovered });
    stoppableChat(client); // Esc in the interactive session ends any model call at once (abort.ts)
    ui.printHeader(process.cwd());
    const cwdShort = basename(process.cwd()) || process.cwd();
    let prior;
    if (isContinue) {
        prior = loadHistory();
        if (prior.length > 0) {
            const userTurns = prior.filter((m) => m.role === "user").length;
            console.log(chalk.dim(`  Continuing conversation (${userTurns} previous messages)\n`));
        }
        else {
            console.log(chalk.dim("  No previous conversation found, starting fresh.\n"));
        }
    }
    else {
        clearHistory();
        prior = [];
    }
    if (!process.stdin.isTTY) {
        ui.warn("ask needs an interactive terminal to read your question (stdin is not a TTY).");
        process.exit(1);
    }
    const promptText = ui.buildPromptText(cwdShort);
    // One message per run (the old behavior) for whatever drives ask from a program: the AI
    // Command Center pastes one message into a pty and waits for ask to exit. A person at a
    // terminal gets the interactive session (session.ts).
    const oneShot = argv.includes("--once") || process.env.EDS_TUI_ONESHOT === "1" || Boolean(process.env.CC_TASK_ID);
    const pool = loadPool();
    const deps = {
        client,
        mainModel,
        smallModel,
        cwd: process.cwd(),
        delegateTask: makeDelegateTask(smallModel, process.cwd(), APP_DIR),
        delegateTaskMain: makeDelegateTask(mainModel, process.cwd(), APP_DIR),
        consultSpecialist: makeConsultSpecialist(pool, smallModel, process.cwd(), APP_DIR),
        saveHistory,
        modelPool: pool,
    };
    // messages[0] is rebuilt for every message (its skill and model can differ); the rest carries over.
    const messages = [{ role: "system", content: "" }, ...prior];
    /** One message: pick its model and skill, build the system prompt for it, run the loop. */
    async function answer(request, namedSkill) {
        const triageFn = (input) => triage(client, input, mainModel, smallModel);
        let active;
        let skill;
        if (forceFast || forceSmart || pinFor(namedSkill, { main: mainModel, small: smallModel })) {
            ({ model: active, skill } = await resolveModel(request, triageFn, { main: mainModel, small: smallModel }, {
                forceFast,
                forceSmart,
                skill: namedSkill,
            }));
        }
        else {
            ({ model: active, skill } = await ui.withSpinner("Routing...", () => resolveModel(request, triageFn, { main: mainModel, small: smallModel }, { skill: namedSkill })));
        }
        ui.printStatusLine(active, skill?.name);
        const renderedSkill = skill ? skills.render(skill) : null;
        const otherSkills = new Map(skills.discover());
        if (skill)
            otherSkills.delete(skill.name);
        const otherSkillsIndex = otherSkills.size > 0 ? skills.indexLines(otherSkills) : null;
        const slotsNow = parallelSlots(nodeConfig, (await discovered) ?? []);
        messages[0] = {
            role: "system",
            content: buildSystemPrompt({
                cwd: process.cwd(),
                appDir: APP_DIR,
                hardMaxTurns: HARD_MAX_TURNS,
                activeModel: active,
                mainModel,
                skill,
                renderedSkill,
                otherSkillsIndex,
                parallelSlots: slotsNow,
            }),
        };
        messages.push({ role: "user", content: request });
        const stats = {};
        await agenticLoop(deps, messages, active, stats);
    }
    if (oneShot) {
        const { text: raw, cancelled, eof } = await promptLine(promptText);
        if (cancelled || eof) {
            console.log(chalk.dim("\nCancelled."));
            process.exit(0);
        }
        const userInput = raw.trim();
        if (!userInput) {
            console.log(chalk.dim("No input. Exiting."));
            process.exit(0);
        }
        console.log();
        if (looksLikeAShellFlag(userInput)) {
            printShellFlagHint(userInput);
            process.exit(0);
        }
        const parsed = extractSkill(userInput);
        if (!parsed)
            process.exit(1);
        await answer(parsed.request, parsed.skill);
        return;
    }
    console.log(chalk.dim("  Keep typing while it works: Enter queues the next message · Esc stops · Ctrl-D exits\n"));
    await runSession({
        promptText,
        run: async (text) => {
            if (looksLikeAShellFlag(text))
                return printShellFlagHint(text);
            const parsed = extractSkill(text);
            if (parsed)
                await answer(parsed.request, parsed.skill);
        },
        stopped: () => {
            repairAfterStop(messages);
            saveHistory(messages);
        },
    });
    process.exit(0);
}
main().catch((e) => {
    console.error(chalk.red(`\nUnexpected error: ${e instanceof Error ? e.message : e}`));
    process.exit(1);
});
//# sourceMappingURL=cli.js.map