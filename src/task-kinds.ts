// What kind of work a request is (git, docker, network, files…), so the
// dispatcher learns which helper model is good at which (experience.ts).
//
// Edgar 2026-10-30: the dispatcher should learn "which model is best at which
// kind of task" from how tasks end. The kind with the most of its words in the
// request, the first in KINDS on a tie, "other" when none. Plain words, no
// model call.
//
// A copy of the AI Command Center's app/task_kinds.py: keep the two in step
// (task-kinds.test.ts checks a few of its answers).

const words = (s: string) => new Set(s.trim().split(/\s+/));

export const KINDS: Record<string, Set<string>> = {
  git: words("branch branches checkout commit commits diff git github merge pr pull push rebase repo repository stash"),
  docker: words("compose container containers docker dockerfile image images k8s kubectl pod podman pods"),
  services: words("boot cron crontab daemon kill pid process processes reboot restart running service services start stop systemctl systemd unit"),
  network: words("cert certificate curl dns domain firewall http https ip network nginx ngrok ping port ports proxy socket ssh ssl tailscale tls tunnel ufw url vpn wget"),
  files: words("backup chmod chown copy df directories directory disk du file files find folder folders grep ls mount move nfs path permission permissions rename rsync size space tar zip"),
  logs: words("crash crashed dmesg error errors journal journalctl log logs stacktrace traceback warning warnings"),
  packages: words("apt brew dependencies dependency install installed npm package packages pip pnpm snap update updates upgrade uv version versions yarn"),
  models: words("benchmark cuda gpu gpus inference llm llms model models nvidia ollama qwen runpod vllm vram"),
  system: words("cpu fan hardware hostname kernel load memory os ram swap temp temperature thermal uptime user users"),
  database: words("database databases db migration migrations mysql postgres postgresql query redis sql sqlite table tables"),
  code: words("api backend bug bugs build class code compile django endpoint fastapi feature frontend function implement javascript lint node pytest python react refactor script test tests typescript"),
};
export const OTHER = "other";

/** The kind of work `text` asks for (see KINDS), or "other". */
export function kindOf(text: string): string {
  const found = (text ?? "").toLowerCase().slice(0, 4000).match(/[a-z0-9][a-z0-9_.+-]*/g) ?? [];
  const ws = found.map((w) => w.replace(/^[.\-+_]+|[.\-+_]+$/g, ""));
  let best = OTHER;
  let hits = 0;
  for (const [kind, vocab] of Object.entries(KINDS)) {
    const n = ws.filter((w) => vocab.has(w)).length;
    if (n > hits) {
      best = kind;
      hits = n;
    }
  }
  return best;
}
