import { test } from "node:test";
import assert from "node:assert/strict";
import { helperReplyOk, readOnly } from "./readonly.js";

// The same commands as the AI Command Center's tests/test_learning.py (app/readonly.py): keep them in step.
const READS: string[] = ["ls -la /var/log", "systemctl status ollama --no-pager", "journalctl -u ollama -n 50 --no-pager", "df -h | sort -k5 -h | tail -5", "find / -name '*.log' 2>/dev/null | head", "git log --oneline -5 && git status", "docker ps -a", "docker compose logs --tail 20", "curl -s http://localhost:11434/api/tags | jq .", "ip -br a", "ps aux | grep -v grep | grep ollama", "tailscale status", "cat /etc/os-release; uname -a", "sed -n 1,20p f", "nvidia-smi --query-gpu=name,memory.used --format=csv", "timeout 5 ping -c 2 8.8.8.8", "cd /tmp && ls", "grep -r error /var/log/syslog 2>&1 | tail", "awk '{print $1}' /etc/passwd", "free -h", "ollama ps", "hostname", "crontab -l", "dpkg -l | grep nginx", "wget -qO- http://x", "top -bn1 | head", "git remote -v", "sort -k2 f"];
const WRITES: string[] = ["rm -rf /tmp/x", "sudo systemctl restart ollama", "systemctl restart ollama", "echo hi > /etc/x", "ls; rm x", "ls\nrm -rf x", "env rm -rf x", "find . -delete", "find . -exec rm {} \\;", "sed -i s/a/b/ f", "curl -X POST u", "curl -d x u", "curl -o f u", "curl -sO u", "docker compose up -d", "docker rm x", "git push", "git branch -D x", "git config user.name x", "bash -c ls", "python3 -c 'print(1)'", "ls $(whoami)", "ls `id`", "sort -o out in", "uniq a b", "hostname newname", "ifconfig eth0 down", "ip link set eth0 down", "tee f", "cat x | sh", "ls &", "kill 123", "mv a b", "cp a b", "chmod 777 x", "awk '{system(\"rm x\")}'", "wget http://x", "crontab -e", "npm install", "pip install x", "apt install x", "xargs rm", "date -s 10:00", "journalctl --vacuum-time=1d", "cat <<EOF > x", "tree -o f", "top", "git stash", "git tag v1", "nvidia-smi -r", "docker system prune -f"];

test("readOnly: commands that only read pass", () => {
  for (const c of READS) assert.deepEqual(readOnly(c), [true, ""], c);
});

test("readOnly: commands that change something don't", () => {
  for (const c of WRITES) {
    const [ok, why] = readOnly(c);
    assert.equal(ok, false, c);
    assert.ok(why, c);
  }
});

test("helperReplyOk: judged by what the reply does", () => {
  const call = (name: string, args: unknown) => ({ tool_calls: [{ function: { name, arguments: args } }] });
  const [okRead] = helperReplyOk(call("run_command", { command: "df -h" }));
  const [okWrite, , faultWrite] = helperReplyOk(call("run_command", { command: "rm x" }));
  const [okJunk, , faultJunk] = helperReplyOk(call("run_command", "{broken"));
  assert.deepEqual(helperReplyOk({ content: "It's running." }), [true, "", false]);
  assert.equal(okRead, true);
  assert.deepEqual([okWrite, faultWrite], [false, false]); // qwen3.8's step, not the helper's fault
  assert.equal(helperReplyOk(call("delegate_task", { task: "x" }))[2], false);
  assert.deepEqual([okJunk, faultJunk], [false, true]);
  assert.equal(helperReplyOk({ content: "<think>hm</think> " })[2], true);
});
