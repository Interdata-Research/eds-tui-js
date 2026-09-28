import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickModels, fallbackClient, desiredModels, DEFAULT_HOST, DEFAULT_MAIN_MODEL } from "./client.js";
import { saveCredentials } from "./credentials.js";

function withTempCredentialsPath(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eds-tui-client-fallback-test-"));
  const path = join(dir, "credentials.json");
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("prefers the desired main/small names when the relay actually has them", () => {
  const { main, small } = pickModels(
    ["tiny:1b", "qwen3.8:latest", "llama3.2:3b"],
    "qwen3.8:latest",
    "tiny:1b"
  );
  assert.equal(main, "qwen3.8:latest");
  assert.equal(small, "tiny:1b");
});

test("falls back to the first available name when the desired main isn't present", () => {
  const { main } = pickModels(["llama3.2:3b", "mistral:7b"], "qwen3.8:latest", "tiny:1b");
  assert.equal(main, "llama3.2:3b");
});

test("falls back to main itself (not some other listed model) when the desired small isn't present", () => {
  const { main, small } = pickModels(["llama3.2:3b", "mistral:7b"], "llama3.2:3b", "tiny:1b");
  assert.equal(main, "llama3.2:3b");
  assert.equal(small, "llama3.2:3b");
});

test("single-model relay: small falls back to main itself", () => {
  const { main, small } = pickModels(["only-model:latest"], "qwen3.8:latest", "tiny:1b");
  assert.equal(main, "only-model:latest");
  assert.equal(small, "only-model:latest");
});

test("empty model list throws, matching the Python original's RuntimeError", () => {
  assert.throws(() => pickModels([], "qwen3.8:latest", "tiny:1b"), /reported no models/);
});

// ---------- fallbackClient: env vars vs. saved `ask --login` credentials ----------

test("fallbackClient: no env vars, no saved login — uses the hardcoded default host, no auth header", () => {
  withTempCredentialsPath((path) => {
    const { client } = fallbackClient("main", "small", {}, path);
    assert.equal((client as any).config.host, DEFAULT_HOST);
    assert.deepEqual((client as any).config.headers, {});
  });
});

test("fallbackClient: no env vars, a saved login exists — uses the saved credentials", () => {
  withTempCredentialsPath((path) => {
    saveCredentials({ hubUrl: "https://app.interdataresearch.ai", token: "relay_saved123" }, path);
    const { client } = fallbackClient("main", "small", {}, path);
    // ollama-js's formatHost() appends the default port when a bare
    // https:// URL has none — confirmed by actually running this, not
    // assumed; not a bug, just how the client normalizes a host.
    assert.equal((client as any).config.host, "https://app.interdataresearch.ai:443");
    assert.deepEqual((client as any).config.headers, { Authorization: "Bearer relay_saved123" });
  });
});

test("fallbackClient: EDS_TUI_URL/EDS_TUI_TOKEN env vars win over a saved login", () => {
  withTempCredentialsPath((path) => {
    saveCredentials({ hubUrl: "https://saved.example", token: "relay_saved" }, path);
    const { client } = fallbackClient(
      "main",
      "small",
      { EDS_TUI_URL: "http://env.example:11434", EDS_TUI_TOKEN: "env-token" },
      path
    );
    assert.equal((client as any).config.host, "http://env.example:11434");
    assert.deepEqual((client as any).config.headers, { Authorization: "Bearer env-token" });
  });
});

test("fallbackClient: EDS_TUI_URL set alone (no token env var) still wins over a saved login entirely — doesn't mix the saved token with the env URL", () => {
  withTempCredentialsPath((path) => {
    saveCredentials({ hubUrl: "https://saved.example", token: "relay_saved" }, path);
    const { client } = fallbackClient("main", "small", { EDS_TUI_URL: "http://env.example:11434" }, path);
    assert.equal((client as any).config.host, "http://env.example:11434");
    assert.deepEqual((client as any).config.headers, {}, "must not pair the saved token with an explicitly different env URL");
  });
});

test("desiredModels: unset env falls back to the package default, and small is just main", () => {
  const { main, small } = desiredModels({});
  assert.equal(main, DEFAULT_MAIN_MODEL);
  assert.equal(small, DEFAULT_MAIN_MODEL);
});

test("desiredModels: EDS_TUI_MODEL / EDS_TUI_SMALL_MODEL are honored when set", () => {
  const { main, small } = desiredModels({
    EDS_TUI_MODEL: "qwen3-coder:30b",
    EDS_TUI_SMALL_MODEL: "llama3.2:3b",
  });
  assert.equal(main, "qwen3-coder:30b");
  assert.equal(small, "llama3.2:3b");
});

test("desiredModels: empty or whitespace-only values fall back rather than requesting a model named \"\"", () => {
  // `printf 'export EDS_TUI_MODEL=%q' ""` in an installer produces exactly
  // this, and asking the relay for "" would 404 every run.
  const { main, small } = desiredModels({ EDS_TUI_MODEL: "", EDS_TUI_SMALL_MODEL: "   " });
  assert.equal(main, DEFAULT_MAIN_MODEL);
  assert.equal(small, DEFAULT_MAIN_MODEL);
});

test("desiredModels: surrounding whitespace is trimmed off a real value", () => {
  const { main } = desiredModels({ EDS_TUI_MODEL: "  qwen3.8:latest\n" });
  assert.equal(main, "qwen3.8:latest");
});
