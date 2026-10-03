import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransient, describeError, withRetries, normalizeToolCalls } from "./retry.js";

// ollama-js throws this shape for a non-2xx reply but doesn't export the class.
class ResponseError extends Error {
  constructor(message: string, public status_code: number) {
    super(message);
    this.name = "ResponseError";
  }
}

const NGINX_502 =
  "<html>\n<head><title>502 Bad Gateway</title></head>\n<body>\n<center><h1>502 Bad Gateway</h1></center>\n" +
  "<hr><center>nginx/1.28.0 (Ubuntu)</center>\n</body>\n</html>\n";

function fetchFailed(code: string): TypeError {
  const cause = Object.assign(new Error("other side closed"), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

test("isTransient: gateway errors and dropped connections are retryable", () => {
  assert.equal(isTransient(new ResponseError(NGINX_502, 502)), true);
  assert.equal(isTransient(new ResponseError("busy", 503)), true);
  assert.equal(isTransient(new ResponseError("timeout", 504)), true);
  assert.equal(isTransient(fetchFailed("UND_ERR_SOCKET")), true);
  assert.equal(isTransient(fetchFailed("ECONNRESET")), true);
  assert.equal(isTransient(new TypeError("fetch failed")), true);
});

test("isTransient: real rejections are not retried", () => {
  assert.equal(isTransient(new ResponseError("unauthorized", 401)), false);
  assert.equal(isTransient(new ResponseError("model not found", 404)), false);
  assert.equal(isTransient(new ResponseError("bad request", 400)), false);
  assert.equal(isTransient(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(isTransient(new Error("something else")), false);
});

test("describeError: an nginx HTML page becomes its one-line title", () => {
  assert.equal(describeError(new ResponseError(NGINX_502, 502)), "HTTP 502 Bad Gateway");
});

test("describeError: 'fetch failed' shows the underlying cause", () => {
  assert.equal(describeError(fetchFailed("UND_ERR_SOCKET")), "UND_ERR_SOCKET: other side closed");
});

type Outcome = Error | string | { errorLine: string } | { cutAfter: string };

/** A client whose chat() streams like ollama-js: rejects up front for HTTP/connection errors, else yields parts. */
function fakeClient(outcomes: Outcome[]) {
  let calls = 0;
  const requests: any[] = [];
  const client = {
    chat: async (req: any) => {
      requests.push(req);
      const next = outcomes[Math.min(calls++, outcomes.length - 1)]!;
      if (next instanceof Error) throw next;
      return (async function* () {
        if (typeof next === "string") {
          for (const word of next.split(/(?= )/)) yield { done: false, message: { role: "assistant", content: word } };
          yield { done: true, done_reason: "stop", eval_count: 3, message: { role: "assistant", content: "" } };
        } else if ("errorLine" in next) {
          yield { done: false, message: { role: "assistant", content: "partial" } };
          throw new Error(next.errorLine); // what ollama-js does with {"error": ...} in a stream
        } else {
          yield { done: false, message: { role: "assistant", content: next.cutAfter } };
          throw new Error("Did not receive done or success response in stream.");
        }
      })();
    },
  };
  return { client: client as any, calls: () => calls, requests };
}

test("withRetries: a non-streaming call is sent streaming and reassembled into one response", async () => {
  const { client, requests } = fakeClient(["hello there world"]);
  withRetries(client, { delaysMs: [], sleep: async () => {} });
  const res = await client.chat({ model: "m", messages: [] });
  assert.equal(requests[0].stream, true);
  assert.equal(res.message.content, "hello there world");
  assert.equal(res.done, true);
  assert.equal(res.eval_count, 3);
});

test("withRetries: tool calls and thinking spread across stream parts are all kept", async () => {
  const client: any = {
    chat: async () =>
      (async function* () {
        yield { done: false, message: { role: "assistant", content: "", thinking: "let me " } };
        yield { done: false, message: { role: "assistant", content: "", thinking: "check", tool_calls: [{ function: { name: "a", arguments: {} } }] } };
        yield { done: false, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "b", arguments: {} } }] } };
        yield { done: true, message: { role: "assistant", content: "" } };
      })(),
  };
  withRetries(client, { delaysMs: [], sleep: async () => {} });
  const res = await client.chat({ model: "m", messages: [] });
  assert.equal(res.message.thinking, "let me check");
  assert.deepEqual(res.message.tool_calls.map((t: any) => t.function.name), ["a", "b"]);
});

test("withRetries: a hub error line mid-stream, or a stream cut short, is retried from scratch", async () => {
  const { client, calls } = fakeClient([{ errorLine: "upstream unreachable" }, { cutAfter: "half a rep" }, "ok"]);
  const retries: string[] = [];
  withRetries(client, { delaysMs: [0, 0, 0], sleep: async () => {}, onRetry: (_a, _n, why) => retries.push(why) });
  const res = await client.chat({ model: "m", messages: [] });
  assert.equal(res.message.content, "ok"); // nothing from the broken attempts leaks in
  assert.equal(calls(), 3);
  assert.deepEqual(retries, [
    "stream interrupted: upstream unreachable",
    "stream interrupted: Did not receive done or success response in stream.",
  ]);
});

test("withRetries: a transient failure is retried and the later success is returned", async () => {
  const { client, calls } = fakeClient([new ResponseError(NGINX_502, 502), fetchFailed("UND_ERR_SOCKET"), "ok"]);
  const retries: string[] = [];
  withRetries(client, { delaysMs: [0, 0, 0], sleep: async () => {}, onRetry: (_a, _n, why) => retries.push(why) });
  const res = await client.chat({ model: "m", messages: [] });
  assert.equal(res.message.content, "ok");
  assert.equal(calls(), 3);
  assert.deepEqual(retries, ["HTTP 502 Bad Gateway", "UND_ERR_SOCKET: other side closed"]);
});

test("withRetries: gives up after the configured retries and rethrows the last error", async () => {
  const { client, calls } = fakeClient([new ResponseError(NGINX_502, 502)]);
  withRetries(client, { delaysMs: [0, 0], sleep: async () => {} });
  await assert.rejects(client.chat({ model: "m", messages: [] }), (e: any) => e.status_code === 502);
  assert.equal(calls(), 3);
});

test("withRetries: a non-transient error is thrown immediately", async () => {
  const { client, calls } = fakeClient([new ResponseError("model not found", 404)]);
  withRetries(client, { delaysMs: [0, 0], sleep: async () => {} });
  await assert.rejects(client.chat({ model: "m", messages: [] }));
  assert.equal(calls(), 1);
});

test("normalizeToolCalls: OpenAI-style string arguments are parsed into an object", () => {
  const [tc] = normalizeToolCalls([{ function: { name: "run_command", arguments: '{"command":"uname -s"}' as any } }]);
  assert.deepEqual(tc!.function.arguments, { command: "uname -s" });
  assert.equal((tc as any).type, "function", "OpenAI-style nodes reject history tool calls without a type");
});

test("withRetries: a tool call missing its name (one node's broken streaming) is re-asked non-streaming", async () => {
  let calls = 0;
  const client: any = {
    chat: async (req: any) => {
      calls++;
      if (!req.stream) {
        // OpenAI-style string arguments, as that node sends them non-streaming.
        return { done: true, message: { role: "assistant", content: "", tool_calls: [{ function: { name: "run_command", arguments: '{"command":"uname -s"}' } }] } };
      }
      return (async function* () {
        yield { done: true, message: { role: "assistant", content: "", tool_calls: [{ index: 0, function: { arguments: "}" } }] } };
      })();
    },
  };
  const retries: string[] = [];
  let slept = 0;
  withRetries(client, { delaysMs: [1000], sleep: async () => void slept++, onRetry: (_a, _n, why) => retries.push(why) });
  const res = await client.chat({ model: "m", messages: [] });
  assert.equal(calls, 2);
  assert.equal(slept, 0, "a malformed reply is re-asked right away, non-streaming");
  assert.equal(res.message.tool_calls[0].function.arguments.command, "uname -s");
  assert.match(retries[0]!, /malformed tool call/);
});
