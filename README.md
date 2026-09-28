# eds-tui

Natural Language Command Executor — a one-shot terminal AI assistant powered
by a local (or network-routed) Ollama-compatible model.

TypeScript rewrite of [edstui](https://github.com/edantonio505/edstui)
(Python/pipx), designed to install as a plain package-manager pull over
HTTPS — no Python/pipx toolchain needed on the target machine.

## Install

```bash
npm install -g eds-tui@latest
```

Needs Node.js >=20. This gives you the `ask` command on PATH. `ask --upgrade`
pulls from the same place, so install and upgrade always agree on what
"latest" means.

If the npm registry isn't reachable (air-gapped, proxy, outage) or you need
something newer than what's published, there's a fallback installer that
clones this repo and installs a locally packed tarball:

```bash
curl -fsSL https://raw.githubusercontent.com/edantonio505/eds-tui-js/main/install.sh | bash
```

Windows (PowerShell): `irm https://raw.githubusercontent.com/edantonio505/eds-tui-js/main/install.ps1 | iex`

That path additionally needs `git`, and it bootstraps Node itself if the box
doesn't have a new enough one. It deliberately avoids `npm install -g
git+https://github.com/...`, which for this repo was confirmed unreliable —
it can report success while silently leaving an incomplete install.

## Configuration

Add to your `~/.bashrc`, `~/.bash_aliases`, or `~/.zshrc`:

```bash
export EDS_TUI_URL="http://your-ollama-host:11434"
export EDS_TUI_TOKEN="your_token_here"   # optional, only if your server requires auth

export EDS_TUI_MODEL="qwen3.8:latest"    # optional, main model
export EDS_TUI_SMALL_MODEL="..."          # optional, a faster model for simpler requests;
                                         # unset = every request runs on EDS_TUI_MODEL
```

Both models must be served from the same Ollama host and support tool calling.

### Logging in (recommended over hand-editing rc files)

```bash
ask --login
```

Prompts for the hub URL and a relay API key (mint one at `<hub-url>/admin/api-keys`
— any logged-in miniaicloud user can create one, not just admins), **validates
it against a real request before saving anything**, and stores it in
`~/.eds_tui/credentials.json`. This is what a stale/wrong `EDS_TUI_TOKEN` used
to look like: it would fail silently somewhere deep in a real conversation on
whatever machine had the bad value in its shell rc file, with no clear signal
about what was actually wrong. `--login` catches that immediately instead —
an invalid token is rejected right there, before it's ever saved.

```bash
ask --whoami    # show the saved login and re-check it still works
ask --logout    # remove the saved login
```

`EDS_TUI_URL`/`EDS_TUI_TOKEN` env vars, if set, always take precedence over a
saved login — same "explicit override beats saved config beats default" shape
used elsewhere. `--login` warns you if it detects those env vars are already
set, since they'd otherwise silently shadow what you just logged in with.

### Auto-connecting through miniclosedai

If a [miniclosedai](https://github.com/edantonio505/miniclosedai) instance is
reachable and it's itself connected to the interdata relay, `ask` uses that
automatically — no config needed beyond what miniclosedai's own installer
already writes to `~/.bash_aliases`. Each run of `ask`:

1. Asks miniclosedai (`GET /relay/api/tags`, ~2s timeout) which models the
   interdata relay currently has.
2. If that succeeds, runs against interdata through miniclosedai's `/relay`
   proxy — preferring `EDS_TUI_MODEL`/`EDS_TUI_SMALL_MODEL` (or their
   `qwen3.8:latest` default) if interdata actually has them,
   else falling back to whatever models interdata does have.
3. If miniclosedai isn't reachable, or interdata isn't connected/enabled,
   `ask` falls straight back to `EDS_TUI_URL`/`EDS_TUI_TOKEN` above, silently
   — no error, no behavior change.

```bash
export EDS_TUI_MINICLOSEDAI_URL="https://127.0.0.1:8095"   # optional, default shown
export EDS_TUI_MINICLOSEDAI_TOKEN=""                       # optional, only if miniclosedai's API auth is enabled
```

## Usage

```bash
ask                  # start a fresh conversation (clears history)
ask --continue       # continue the previous conversation
ask --fast           # force the small model for this request
ask --smart          # force the main model for this request
ask --skills         # list installed skills
ask --skill-new NAME # scaffold a new skill
ask --login          # save a validated hub URL + relay API key to ~/.eds_tui/credentials.json
ask --whoami         # show the saved login and re-check it still works
ask --logout         # remove the saved login
ask --test           # self-check: prove routing, skills, delegation, escalation, specialist routing and consult work
ask --upgrade        # update to the latest published version (npm install -g eds-tui@latest)
ask --version        # print the installed version and exit
```

## Model routing

Routing has three tiers. **Mainly the first two are used** — the third only
kicks in when a task genuinely proves too hard for the main model.

1. **Triage** (every request): a short classification call to the small
   model decides whether the request is simple — a lookup, a listing, a
   status check, a one-off command — or complex enough to need the main
   model. The whole agentic loop then runs on whichever model was picked,
   printed above the answer. Use `--fast`/`--smart` to skip triage and force
   a model.
2. **Escalation** (small → main): if the small model takes a request and
   then stalls — more than 6 tool-call rounds, or a request error — the
   conversation hands off to the main model and continues from there
   (`↑ escalating to ...`). It inherits the transcript, not the small
   model's spent turn budget, so it gets a full fresh 14 rounds.
3. **Tier 3 — specialist escalation** (main → a network specialist): if the
   *main* model also exhausts its own turn budget without concluding, `ask`
   tries once more before giving up — it asks the small model to pick the
   best-fit entry from a specialist pool you configure (see below), and, if
   one clearly fits, hands the request to that model instead, with a full
   fresh budget and the same tools the main model gets. Only fires once per
   request; if the specialist also can't finish, the run salvages an answer
   from whatever it found, same as tier 1→2.

Separately, see [Consulting a specialist mid-task](#consulting-a-specialist-mid-task)
for a way the main model can reach for a specialist **by choice**, on just
one hard piece of a task, without giving up control of the rest.

### Configuring the specialist pool

Not configured by default — tier 3 (and `consult_specialist`, below) simply
never fire until you set this up. Create `~/.eds_tui/models.json`. A good
starting point for coding work, using models live on the interdata network
as of this writing (check what your own network actually serves — model
availability changes; `qwen3-coder-next`, an earlier example here, has since
been retired):

```json
[
  { "name": "deepseek-v4-pro:cloud", "good_for": "deep multi-step reasoning, tricky algorithms, hard bug root-causing, proofs of correctness" },
  { "name": "kimi-k3:cloud", "good_for": "large-context codebase understanding, big multi-file refactors, long design/architecture writeups" },
  { "name": "glm-5.3:cloud", "good_for": "fast iterative debugging, translating between languages/frameworks, general-purpose coding help" },
  { "name": "qwen3-coder:30b", "good_for": "focused code generation and syntax-precise edits in a single file or function, fast local turnaround" }
]
```

Each entry needs a real model name reachable on whatever host `ask` is
already talking to, and a one-line `good_for` — that's the *only* thing the
routing model sees when deciding whether an entry fits a given request, the
same reason [skills](#skills) carry a one-line description rather than
expecting a model to infer intent from a bare name. Keep this list small and
genuinely differentiated: a live interdata-style network can carry 20-40+
models, many near-duplicate variants of the same base model at different
sizes or hosting — an undifferentiated dump of all of them doesn't give the
small model anything real to route on. The same pool file serves both tier-3
(matched against the whole original request) and `consult_specialist`
(matched against one sub-task at a time) — no duplication needed.

A malformed or missing file degrades to "no specialist pool," never an
error — same never-throws discipline the skills registry uses.

## Turn budget

Each model gets up to 40 tool-call rounds per request (8 for a
`consult_specialist` call, 5 for a delegated sub-agent). **Escalation resets
that budget** — the newly-active model inherits the transcript, not the
rounds already spent, so a request that escalates does not leave the next
tier with fewer rounds to finish an investigation it just walked into. (One
documented exception: if a model's own request *errors out* rather than
running out of rounds, the escalation that follows does *not* reset the
counter — it keeps counting from wherever it was. A budget-exhaustion
escalation and a request-failure escalation are different situations and get
different treatment.)

Three things keep a long run from either ending empty-handed or blowing up
its own context window:

- **Repeated commands are not re-run.** If the model asks for a command it
  already ran this session, the earlier output is replayed with a note
  saying so, and the round is not spent on the shell.
- **Command output is clipped at ~8,000 characters**, head and tail kept,
  with a note telling the model to narrow the search.
- **A long transcript is compacted, not left to grow forever.** Once a
  run's total message content passes ~60,000 characters, `ask` collapses
  the *middle* of the conversation into one short summary (produced by the
  small model), while always keeping the system prompt, the current
  request, and the last 3 rounds verbatim. This is what actually makes long
  coding sessions viable — a 40-round budget would otherwise mean sending
  an ever-growing transcript on every single round.
- **Running out of rounds produces an answer, not an error.** At the cap,
  `ask` first tries tier-3 escalation (if configured); failing that, it
  makes one final call with the tools removed, so the model has to conclude
  from the evidence already gathered and say what it could not confirm.

## Skills

A skill is a reusable procedure you write once and `ask` loads when it is
relevant — how *you* ship a release, how *you* restore a dev database, the
three commands that actually diagnose a bad deploy on *your* machine.

### Bundled default: `hard-task-claude`

The very first time `ask` runs and finds no `~/.eds_tui/skills/` at all — a
genuinely fresh install — it seeds one default skill there:
`hard-task-claude`, which reaches for the [Claude Code](https://claude.com/claude-code)
CLI (`claude -p`), if it's installed, for tasks that are truly beyond
direct shell work (large multi-file refactors, a stuck bug, real algorithm
design). This is **one-time only** — once the directory exists at all,
nothing is ever seeded again, so editing or deleting it is a durable choice,
not something that quietly comes back on the next run. If `claude` isn't
installed, the skill says so and falls back to `consult_specialist` (below)
or the model's own best effort, rather than pretending to have run it.

They live in `~/.eds_tui/skills/`, one directory each:

```
~/.eds_tui/skills/
  deploy-flow/
    SKILL.md
```

`SKILL.md` is frontmatter plus a Markdown body:

```markdown
---
name: deploy-flow
description: Ship a release from this repo — branch checks, tag, push, verify.
model: main
---

1. Confirm the working tree is clean and we are not on `main`.
2. ...
```

- `description` is **required** — the only thing the model sees until the
  skill loads, so make it specific.
- `name` defaults to the directory name.
- `model` is `main`, `small` or `any` (default).

Frontmatter is flat `key: value` only — nested YAML is not supported.

Three ways to write one, increasing order of how much you should trust the
result: `ask --skill-new NAME` scaffolds a starter file; ask `ask` for it
("remember how to check what's using a port, make it a skill") — the main
model has a `create_skill` tool that writes the file and immediately
re-reads it through the real parser; or write the file yourself.

**Read what the model writes before trusting it.** `create_skill` guarantees
the *file* is valid, not that the *commands in it* are correct.

Skills are read from your home directory only, never the working directory
— picking them up from whatever repo you `cd` into would turn cloning a
repository into a code-execution path.

## Delegation

The main model (or a tier-3 specialist standing in for it) also gets a
`delegate_task` tool and can spawn a sub-agent — by default the **small**
model — for mechanical legwork: gathering listings, counting things,
checking status — while it stays on the reasoning. A sub-agent gets shell
access but no delegation tool of its own and no view of the parent
conversation, so each delegated task has to stand alone. It runs its own
agentic loop (up to 5 steps) and returns a text report as the parent's tool
result.

Passing `model:"main"` hands the subtask to the **main** model instead — the
network's full-capability model (`qwen3.8:latest` by default) — for a
subtask that genuinely needs real reasoning, not just legwork.

### Parallel fan-out (`delegate_tasks`)

When it has several genuinely **independent** pieces of work — nothing that
depends on another task's result — the main model can hand them all to
`delegate_tasks` at once instead of calling `delegate_task` repeatedly.
They run **at the same time as each other**, not one after another: real
concurrency (`Promise.all`, not a queue), each with its own sub-agent, its
own shell, and no visibility into the others. Their combined reports come
back as one tool result, labeled by task number. The same `model:"small"|
"main"` choice applies to the whole batch.

This isn't just faster because the tasks overlap — it's faster because a
network with more than one node serving the delegate model spreads
concurrent requests across them for free. miniaicloud's relay round-robins
across every backend registered for a given model name on each request; `ask`
never has to know or care which physical node ends up doing the work.
Measured live against a real multi-node network: 4 independent delegated
tasks took **2.07x longer run one at a time than run concurrently**. Firing
several `model:"main"` tasks at once is how you deliberately spread real
reasoning work across the network's `qwen3.8:latest`-class nodes specifically
— not just the small model's cheap legwork.

## Consulting a specialist mid-task

`delegate_task`/`delegate_tasks` hand off work to the *small* model by
default, or the *main* model with `model:"main"`. Tier-3 escalation (above)
hands off the *entire remaining session* to a specialist, but only
mechanically, as a last resort, once the main model
has already run out of turns or hit an error.

`consult_specialist` is a third, different thing: the main model (or a
tier-3 specialist standing in for it) can reach for it **by choice**, any
number of times, for just ONE genuinely hard sub-piece of what it's working
on — a tricky function, a subtle bug, an algorithm it isn't confident about
— while staying in charge of the task overall. It automatically picks
whichever pool entry (same `~/.eds_tui/models.json` as tier-3) best fits
that specific sub-piece, hands it a self-contained brief (it can't see the
rest of the conversation), and runs its own bounded loop (up to 8 rounds)
with shell access. The result comes back labeled with which specialist
answered, and the main model picks up where it left off. If no specialist in
the pool is a clearly better fit, it says so instead of guessing — same
policy as tier-3's own routing.

Only offered to the model at all when a pool is configured — same gating
`load_skill` gets when no skills exist.

## Self-check

`ask --test` exercises the whole arrangement against your live server and
reports pass/fail, exiting nonzero if anything broke — including a real
tier-3 escalation and a real `consult_specialist` call if
`~/.eds_tui/models.json` is configured for your network. The skill checks
build a throwaway fixture in a temp directory — they never touch your real
`~/.eds_tui/skills`.

## Conversation history

By default, every run of `ask` starts a completely fresh conversation. Use
`ask --continue` to keep the context going across multiple runs — history is
saved to `~/.eds_tui_history.json` after each response, and running `ask`
without `--continue` always clears it.

## How it works

- Type your question and press Enter to submit
- Paste multi-line text — it collapses to `[+N lines]` so you can keep typing
- The model can run shell commands on your machine to answer questions
- Exits after one question and answer
