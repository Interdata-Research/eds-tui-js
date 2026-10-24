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
import { Ollama } from "ollama";
import { makeClient, desiredModels, jsonErrors } from "./client.js";
import { loadCredentials } from "./credentials.js";
import { triage } from "./triage.js";
import { resolveModel, pinFor } from "./resolve-model.js";
import { withNodeRouting, loadNodeConfig, parallelSlots, isRelayOnly, relayName } from "./nodes.js";
import { discoverCached, discoverNodes } from "./discover.js";
import { ranked, refreshRanking, strength } from "./ranking.js";
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
const NOTHING_FOUND = { urls: [], duplicates: {}, small: [] };
/** More qwen3.8 servers and smaller qwens on the network (discover.ts), unless the configuration turns that off. */
function discoveryFor(cfg, model) {
    if (!cfg.discover)
        return undefined;
    const configured = [...cfg.direct, ...cfg.lastResort].filter((u) => !isRelayOnly(u));
    return discoverCached({ model, configured, tokens: cfg.tokens }).catch(() => NOTHING_FOUND);
}
/** The relay that carries nodes' requests (pinned to each), from EDS_TUI_URL/TOKEN or `ask --login`; none when it
 *  isn't an https relay, or EDS_TUI_VIA_RELAY=0. */
function relayFor(env) {
    if (env.EDS_TUI_VIA_RELAY === "0")
        return undefined;
    const saved = env.EDS_TUI_URL || env.EDS_TUI_TOKEN ? undefined : loadCredentials();
    const url = (env.EDS_TUI_URL ?? saved?.hubUrl ?? "").replace(/\/+$/, "");
    const token = env.EDS_TUI_TOKEN ?? saved?.token ?? "";
    return /^https:\/\//.test(url) ? { url, ...(token ? { token } : {}) } : undefined;
}
/** A configured address's name on the relay: its tailnet twin, which discover.ts saw as the same server. */
function relayNames(d) {
    const names = {};
    for (const [twin, of] of Object.entries(d.duplicates))
        names[of] ??= twin;
    return names;
}
/** How a server's benchmark goes: through the relay pinned to it, then straight (ranking.ts). */
function routesFor(cfg, relay, names) {
    return (url) => [
        ...(relay
            ? [{ url: relay.url, headers: { ...(relay.token ? { Authorization: `Bearer ${relay.token}` } : {}), "X-Interdata-Node": relayName(url, names) } }]
            : []),
        ...(isRelayOnly(url) ? [] : [{ url, headers: cfg.tokens?.[url] ? { Authorization: `Bearer ${cfg.tokens[url]}` } : {} }]),
    ];
}
/** The AI Command Center's router answers (a quick metadata call). */
async function routerUp(r) {
    try {
        const res = await fetch(`${r.url}/api/version`, {
            headers: r.token ? { Authorization: `Bearer ${r.token}` } : {},
            signal: AbortSignal.timeout(2_000),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
/** `ask --nodes`: the qwen servers ask uses, looked up and benchmarked fresh, strongest first. */
async function printNodes(model) {
    const cfg = loadNodeConfig(process.env);
    console.log();
    if (cfg.router && !process.env.EDS_TUI_URL) {
        const up = await routerUp(cfg.router);
        console.log(chalk.bold.whiteBright("  AI Command Center router"));
        console.log(`  ${cfg.router.url}  ${up ? chalk.green("answers: every request goes there (it ranks and spreads them for this whole machine)") : chalk.red("doesn't answer: ask routes by itself, below")}`);
        console.log();
    }
    const configured = [...cfg.direct, ...cfg.lastResort];
    const reachable = configured.filter((u) => !isRelayOnly(u));
    const found = cfg.discover ? await discoverNodes({ model, configured: reachable, tokens: cfg.tokens }) : NOTHING_FOUND;
    const relay = relayFor(process.env);
    const leases = fileLeases();
    const direct = [...cfg.direct, ...found.urls];
    console.log(chalk.dim(`  Benchmarking ${direct.length} server(s)…`));
    const ranking = await refreshRanking({
        urls: direct, model, modelFor: (u) => found.models?.[u], routesFor: routesFor(cfg, relay, relayNames(found)), leases, force: true,
    });
    const why = (u) => (isRelayOnly(u) ? "configured, through the relay only" : cfg.direct.includes(u) ? "configured" : "found on the network");
    console.log(chalk.bold.whiteBright(`  ${model} servers, strongest first`));
    ranked(direct, ranking, cfg.slots).forEach((url, i) => {
        const m = ranking[url];
        const state = m
            ? chalk.green(`benchmark ${m.est.toFixed(1)}s, ${strength(m, cfg.slots?.[url] ?? 1).toFixed(2)} requests/s with every slot busy`)
            : chalk.red("didn't answer the benchmark");
        console.log(`  ${i + 1}. ${url}  ${chalk.dim(`${why(url)}, ${cfg.slots?.[url] ?? 1} at a time, ${leases.count(url)} running now`)}  ${state}`);
    });
    for (const s of found.small)
        console.log(`  ·  ${s.url}  ${chalk.dim(`${s.model} (${s.params}B): small jobs when every ${model} server is busy`)}`);
    for (const s of found.idle ?? [])
        console.log(`  ·  ${s.url}  ${chalk.dim(`has ${s.model}, not loaded: not used (never made to load it)`)}`);
    for (const url of cfg.lastResort)
        console.log(`  ·  ${url}  ${chalk.dim("last resort (only when the hub fails)")}`);
    for (const [dup, of] of Object.entries(found.duplicates)) {
        if (!configured.includes(dup))
            console.log(chalk.dim(`  ${dup}  same server as ${of}, not used twice${relay ? " (its name on the relay)" : ""}`));
    }
    if (!cfg.discover)
        console.log(chalk.dim("  (looking on the network is off: EDS_TUI_DISCOVER=0, an explicit EDS_TUI_DIRECT_NODES, or \"discover\": false)"));
    console.log(chalk.dim(`  Up to ${parallelSlots(cfg, found.urls)} requests run at once on these; more go to the hub, which spreads them over the network.`));
    console.log(chalk.dim(relay ? `  Requests go through the relay ${relay.url}, pinned to each server, so it logs them.` : "  Requests go straight to each server (no https relay configured)."));
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
    let { client, mainModel, smallModel } = await makeClient(main, small, process.env);
    const nodeConfig = loadNodeConfig(process.env);
    const relay = relayFor(process.env);
    let discovered;
    if (nodeConfig.router && !process.env.EDS_TUI_URL && (await routerUp(nodeConfig.router))) {
        // The AI Command Center's router on this machine ranks and spreads every request of every ask and task here
        // (strongest qwen first, through the relay); the relay itself is the last resort if the router fails.
        const r = nodeConfig.router;
        client = new Ollama({ host: r.url, headers: r.token ? { Authorization: `Bearer ${r.token}` } : {}, fetch: jsonErrors(fetch) });
        mainModel = main;
        smallModel = small;
        withNodeRouting(client, { direct: [], lastResort: relay ? [relay.url] : [], tokens: relay?.token ? { [relay.url]: relay.token } : {} }, { retry: { onRetry: ui.printRetrying } });
    }
    else {
        const discovery = discoveryFor(nodeConfig, mainModel); // runs while the user types
        discovered = discovery?.then((d) => d.urls);
        const names = (discovery ?? Promise.resolve(NOTHING_FOUND)).then(relayNames);
        withNodeRouting(client, nodeConfig, {
            retry: { onRetry: ui.printRetrying },
            discovered,
            small: discovery?.then((d) => d.small),
            models: discovery?.then((d) => d.models ?? {}),
            relay: relay ? { ...relay, names } : undefined,
        });
        // Keep the ranking measured (stale ones, idle ones) while this ask runs.
        void (discovery ?? Promise.resolve(NOTHING_FOUND))
            .then(async (d) => refreshRanking({
            urls: [...nodeConfig.direct, ...d.urls], model: mainModel, modelFor: (u) => d.models?.[u],
            routesFor: routesFor(nodeConfig, relay, relayNames(d)), leases: fileLeases(),
        }))
            .catch(() => { });
    }
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
    console.log(chalk.dim("  Keep typing while it works to queue more messages · Esc stops\n"));
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