// Does a shell command only look, never change anything? The check a helper
// model's terminal work passes (nodes.ts: the ladder).
//
// Edgar 2026-10-30: the helper models (the Raspberry Pi's lfm2.5, the small
// qwens…) may run terminal commands for easy work, but at first only ones
// that change nothing (status, logs, finding files); anything else moves up to
// qwen3.8. Allowed: a known list of commands that only read (ALWAYS), commands
// whose read-only subcommands are listed (SUBCOMMANDS: `systemctl status`,
// `git log`, `docker ps`…), minus their writing flags (FORBIDDEN_FLAGS: `find
// -delete`, `sed -i`, `curl -d`…), joined by pipes, `;`, `&&`, `||`. Never:
// sudo, a shell or interpreter, command substitution, writing redirections
// (only to /dev/null), here-documents, a background `&`. When unsure: no.
//
// A copy of the AI Command Center's app/readonly.py: keep the two in step.
const words = (s) => new Set(s.trim().split(/\s+/));
const ALWAYS = words(`
ls ll la dir cat head tail grep egrep fgrep rg ag ack locate which whereis type file stat wc cut tr column nl tac
rev diff cmp comm md5sum sha1sum sha256sum du df free uptime uname whoami id groups cal pwd echo printf true false
test [ basename dirname realpath readlink ps pgrep pstree lsof ss netstat ping dig nslookup host getent lsblk
findmnt lscpu lsusb lspci lsmod nproc vmstat iostat mpstat sensors last lastlog w who users jq zcat zgrep od
strings printenv ulimit`);
/** Read-only only without arguments (hostname NAME sets it…), or with at most N files. */
const NO_ARGS = { hostname: 0, ifconfig: 0, uniq: 1, tree: -1 };
const SUBCOMMANDS = {
    systemctl: words("status is-active is-enabled is-failed list-units list-unit-files list-timers list-sockets list-dependencies show cat --version --failed"),
    service: words("--status-all"),
    docker: words("ps images logs inspect stats version info top port diff history compose container image network volume system"),
    git: words("status log diff show branch remote rev-parse describe ls-files ls-tree blame grep shortlog tag config stash reflog cat-file --version"),
    tailscale: words("status ip ping version netcheck whois"),
    ollama: words("list ls ps show --version -v"),
    ip: words("a addr address r route l link n neigh -br -c -4 -6 -s"),
    npm: words("ls list view outdated -v --version config"),
    pip: words("list show freeze --version"),
    pip3: words("list show freeze --version"),
    apt: words("list show policy search"),
    "apt-cache": words("show policy search depends rdepends"),
    dpkg: words("-l -L -s -S --list --listfiles --status --search"),
    snap: words("list info version"),
    hostnamectl: words("status"),
    timedatectl: words("status show list-timezones"),
    loginctl: words("list-sessions list-users show-session show-user session-status user-status"),
    crontab: words("-l"),
    journalctl: null,
    "nvidia-smi": null,
    find: null,
    sed: null,
    awk: null,
    curl: null,
    wget: null,
    dmesg: null,
    top: null,
    sort: null,
    date: null,
    xargs: null,
    timeout: null,
    nice: null,
    time: null,
};
const SECOND_WRITES = words(`up down start stop restart rm kill pull push build create run exec prune remove rmi tag
load save import commit cp pause unpause update rename connect disconnect set unset add del delete flush change replace
drop apply clear -d -D -m -M --delete --move --unset --add --replace-all --remove-section --rename-section -f --force
set-url`);
const FORBIDDEN_FLAGS = {
    find: words("-exec -execdir -delete -ok -okdir -fprint -fprint0 -fprintf -fls"),
    journalctl: words("--vacuum-size --vacuum-time --vacuum-files --rotate --flush --relinquish-var --setup-keys --update-catalog"),
    "nvidia-smi": words("-r --gpu-reset -pm --persistence-mode -pl --power-limit -ac --applications-clocks -lgc --lock-gpu-clocks -rgc -lmc -rmc -c --compute-mode -e --ecc-config -mig --multi-instance-gpu"),
    curl: words("-X --request -d --data --data-raw --data-binary --data-urlencode --json -F --form -T --upload-file -o --output -O --remote-name -K --config -c --cookie-jar --create-dirs"),
    dmesg: words("-c -C --clear --read-clear -n --console-level -D -E"),
    sort: words("-o --output"),
    date: words("-s --set"),
};
const SHELLS = words(`sh bash zsh dash fish ksh sudo su doas pkexec eval exec source . python python3 node perl ruby php
lua tee dd ssh scp rsync env nohup setsid stdbuf ionice watch chroot busybox yq xxd`);
const SAFE_REDIRECT = /(?:\d?|&)>>?\s*\/dev\/null|\d?>&\d|<\s*\/dev\/null/g;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const OPERATORS = new Set([";", "&&", "||", "|", "|&", ";;"]);
/** Split like a shell would, enough to judge it: words (quotes kept together) and operator tokens. */
function tokenize(cmd) {
    const out = [];
    let cur = "";
    let has = false;
    let quote = null;
    const push = () => {
        if (has)
            out.push(cur);
        cur = "";
        has = false;
    };
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i];
        if (quote) {
            if (c === quote)
                quote = null;
            else if (c === "\\" && quote === '"' && i + 1 < cmd.length)
                cur += cmd[++i];
            else
                cur += c;
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            has = true;
        }
        else if (c === "\\" && i + 1 < cmd.length) {
            cur += cmd[++i];
            has = true;
        }
        else if (/\s/.test(c))
            push();
        else if (";&|<>".includes(c)) {
            push();
            let op = c;
            while (i + 1 < cmd.length && ";&|<>".includes(cmd[i + 1]))
                op += cmd[++i];
            out.push(op);
        }
        else {
            cur += c;
            has = true;
        }
    }
    if (quote)
        return null;
    push();
    return out;
}
/** [true, ""] when every part of `command` only reads; else [false, why]. */
export function readOnly(command) {
    const cmd = (command ?? "").trim();
    if (!cmd)
        return [false, "an empty command"];
    if (cmd.includes("$(") || cmd.includes("`") || cmd.includes("<(") || cmd.includes(">("))
        return [false, "command substitution"];
    if (cmd.includes("<<"))
        return [false, "a here-document"];
    const tokens = tokenize(cmd.replace(SAFE_REDIRECT, " ").replace(/\n/g, " ; ")); // a second line is a second command
    if (!tokens)
        return [false, "can't read it (an unclosed quote)"];
    let segment = [];
    for (const tok of [...tokens, ";"]) {
        if (OPERATORS.has(tok)) {
            if (segment.length) {
                const [ok, why] = segmentOk(segment);
                if (!ok)
                    return [false, why];
            }
            segment = [];
        }
        else if (/^[;&|<>]+$/.test(tok)) {
            return [false, tok.includes(">") ? "a redirection that writes" : tok === "&" ? "a background job" : `'${tok}'`];
        }
        else
            segment.push(tok);
    }
    return [true, ""];
}
function segmentOk(all) {
    let w = all;
    while (w.length && ASSIGN.test(w[0]))
        w = w.slice(1); // VAR=value cmd …
    if (!w.length)
        return [false, "only a variable assignment"];
    const name = w[0].split("/").pop();
    const args = w.slice(1);
    if (name === "cd")
        return [true, ""];
    if (SHELLS.has(name))
        return [false, `${name} runs anything`];
    if (["xargs", "timeout", "nice", "time"].includes(name)) {
        let rest = args.filter((a) => !a.startsWith("-"));
        if (name === "timeout" && rest.length)
            rest = rest.slice(1); // the duration
        if ((name === "xargs" || name === "nice") && args.some((a) => ["-n", "-I", "-L", "-P", "-d"].includes(a)))
            return [false, `${name} with options (unsure what it runs)`];
        return rest.length ? segmentOk(rest) : [name !== "timeout", `${name} alone`];
    }
    if (ALWAYS.has(name))
        return [true, ""];
    if (name in NO_ARGS) {
        if (name === "tree")
            return args.some((a) => a.startsWith("-o")) ? [false, "tree -o writes a file"] : [true, ""];
        const files = args.filter((a) => !a.startsWith("-"));
        const max = NO_ARGS[name];
        if (files.length > max || (max === 0 && args.length && !(args.length === 1 && args[0] === "-a")))
            return [false, `${name} with those arguments changes something`];
        return [true, ""];
    }
    if (!(name in SUBCOMMANDS))
        return [false, `${name} isn't on the read-only list`];
    const bad = FORBIDDEN_FLAGS[name] ?? new Set();
    for (const a of args) {
        const flag = a.split("=", 1)[0];
        if (bad.has(flag) || (name === "curl" && /^-[a-zA-Z]*[dFTKoOX][a-zA-Z]*$/.test(flag) && flag.length > 2))
            return [false, `${name} ${flag} writes or changes something`];
    }
    if (name === "sed" && args.some((a) => a.startsWith("-i") || a.startsWith("--in-place") || /(^|;)\s*w\s/.test(a)))
        return [false, "sed -i edits files"];
    if (name === "awk" && args.some((a) => /system\s*\(|print[^;]*>|\|\s*"/.test(a)))
        return [false, "awk that writes or runs commands"];
    if (name === "wget" && !args.some((a, i) => a === "-O-" || a === "-qO-" || (a === "-O" && args[i + 1] === "-")))
        return [false, "wget saves a file (only -O- reads)"];
    if (name === "top" && !args.some((a) => a.startsWith("-b")))
        return [false, "top without -b is interactive"];
    const subs = SUBCOMMANDS[name];
    if (subs === null || subs === undefined)
        return [true, ""];
    const first = args.find((a) => !a.startsWith("-") || subs.has(a));
    if (first === undefined)
        return [false, `${name} without a subcommand`];
    if (!subs.has(first))
        return [false, `${name} ${first} isn't read-only`];
    const after = args.slice(args.indexOf(first) + 1);
    const writes = after.find((a) => SECOND_WRITES.has(a));
    if (["docker", "git", "ip", "npm"].includes(name) && writes !== undefined)
        return [false, `${name} ${first} ${writes} changes something`];
    if (name === "git" && first === "config" && !after.some((a) => ["--get", "--list", "-l", "--get-all", "--show-origin"].includes(a)))
        return [false, "git config that sets a value"];
    if (name === "git" && first === "stash" && !["list", "show"].includes(after[0] ?? ""))
        return [false, "git stash that changes the work tree"];
    if (name === "git" && first === "branch" && after.some((a) => !a.startsWith("-")))
        return [false, "git branch that creates one"];
    if (name === "git" && first === "tag" && after.some((a) => !a.startsWith("-")) && !after.includes("-l"))
        return [false, "git tag that creates one"];
    if (name === "npm" && first === "config" && !["get", "list", "ls"].includes(after[0] ?? ""))
        return [false, "npm config that sets a value"];
    return [true, ""];
}
/** A helper's tools: what it may call without a qwen3.8 checking (eds-tui's names). */
export const HELPER_TOOLS = new Set(["run_command", "load_skill", "view_image"]);
/** Is a helper model's chat reply fine to hand back? [ok, why not, its fault]. Its fault: an empty or garbled
 *  reply (keeps the rest of this run off helpers); not its fault: a step that needs more than reading. */
export function helperReplyOk(message) {
    const calls = message?.tool_calls ?? [];
    if (!calls.length) {
        const text = String(message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        return text ? [true, "", false] : [false, "an empty reply", true];
    }
    for (const c of calls) {
        const fn = c?.function ?? {};
        const name = fn.name;
        const args = fn.arguments;
        if (typeof args === "string")
            return [false, `garbled arguments for ${name}`, true];
        if (!HELPER_TOOLS.has(name))
            return [false, `${name || "an unnamed tool"} is qwen3.8's to decide`, !name];
        if (name === "run_command") {
            const command = args?.command;
            if (typeof command !== "string" || !command.trim())
                return [false, "run_command without a command", true];
            const [ok, why] = readOnly(command);
            if (!ok)
                return [false, `\`${command.slice(0, 120)}\` isn't read-only (${why})`, false];
        }
    }
    return [true, "", false];
}
//# sourceMappingURL=readonly.js.map