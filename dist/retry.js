// Retries for model requests that fail for transport reasons.
//
// The interdata hub picks a node per request, and several nodes can serve
// the same model (qwen3.8:latest has more than one). A request that dies
// because the node it landed on dropped the connection, timed out, or the
// hub's nginx answered 502/503/504 says nothing about the request itself —
// sending it again gives the hub a chance to route it to a healthy node.
// Before this, one such failure ended the run (the "wrap up" request that
// followed usually hit the same failure).
//
// Requests are sent STREAMING under the hood and reassembled, so callers
// still get one complete ChatResponse. Non-streaming is what made long
// requests fragile: the hub (and its nginx, and RunPod's proxy) send nothing
// until generation finishes, so a long generation sits on an idle connection
// that something along the way eventually cuts — undici's 300s headers
// timeout ("fetch failed"), a proxy timeout, or the hub's nginx (an HTML
// 502). Streamed, the hub answers 200 immediately and bytes keep flowing.
// The hub only fails over to another node before the first byte; once a
// stream is running, a dying node arrives as an error line (or the stream
// just stops), and the only recovery is to send the whole request again —
// safe here because nothing of a reply is shown until it is complete.
//
// Applied once, to the client, so every caller (main loop, sub-agents,
// triage, compaction, final answer) gets it without threading options
// through.
const DEFAULT_DELAYS_MS = [2_000, 5_000, 10_000];
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const TRANSIENT_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CLOSED",
    "STREAM_INTERRUPTED",
]);
/** A stream that broke after it started: an error line from the hub, a cut connection, no final chunk. */
export class StreamInterruptedError extends Error {
    code = "STREAM_INTERRUPTED";
    /** Set when the reply arrived but a tool call in it was unusable. */
    malformed = false;
    constructor(cause) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = "StreamInterruptedError";
    }
}
function errorCode(e) {
    const code = e?.code;
    return typeof code === "string" ? code : undefined;
}
function statusOf(e) {
    const status = e?.status_code;
    return typeof status === "number" ? status : undefined;
}
/** Whether a failed request is worth sending again (vs. a real rejection like 400/401/404). */
export function isTransient(e) {
    const status = statusOf(e);
    if (status !== undefined)
        return TRANSIENT_STATUS.has(status);
    if (e instanceof Error && e.name === "AbortError")
        return false; // the caller cancelled
    const cause = e?.cause;
    const code = errorCode(e) ?? errorCode(cause);
    if (code)
        return TRANSIENT_CODES.has(code);
    // undici's generic wrapper for a network-level failure with no code we know.
    return e instanceof TypeError && e.message === "fetch failed";
}
/**
 * A one-line reason for a failed request. undici reports every network
 * failure as "fetch failed" with the real reason on `.cause`, and an nginx
 * error page arrives as a whole HTML document — neither is useful on screen.
 */
export function describeError(e) {
    if (!(e instanceof Error))
        return String(e);
    const status = statusOf(e);
    if (status !== undefined) {
        const html = /<title>([^<]*)<\/title>/i.exec(e.message);
        if (html)
            return `HTTP ${html[1].trim()}`;
        const oneLine = e.message.replace(/\s+/g, " ").trim();
        return oneLine.startsWith("Error ") || oneLine.startsWith(String(status)) ? oneLine : `HTTP ${status}: ${oneLine}`;
    }
    if (e instanceof StreamInterruptedError) {
        return `stream interrupted: ${e.cause instanceof Error ? describeError(e.cause) : e.message}`;
    }
    const cause = e.cause;
    if (e.message === "fetch failed" && cause instanceof Error) {
        const code = errorCode(cause);
        return code ? `${code}: ${cause.message}` : cause.message;
    }
    return e.message;
}
/**
 * Some nodes behind the hub don't speak Ollama's tool-call format exactly:
 * arguments arrive as a JSON string (OpenAI style) instead of an object, and
 * one node's streaming shim sends only the last fragment of a call
 * (`{"function":{"arguments":"}"}}` — no name, no command). String arguments
 * are parsed; a call that still has no name or unusable arguments means the
 * reply is broken, so it is retried like any other broken stream (round
 * robin usually lands the retry on a different node). Every kept call also
 * gets `type: "function"` (see below).
 */
function malformedError(message) {
    const e = new StreamInterruptedError(new Error(message));
    e.malformed = true;
    return e;
}
export function normalizeToolCalls(calls) {
    return calls.map((tc) => {
        const fn = tc.function ?? {};
        let args = fn.arguments ?? {};
        if (typeof args === "string") {
            try {
                args = args.trim() ? JSON.parse(args) : {};
            }
            catch {
                throw malformedError(`malformed tool call from the model server (arguments: ${JSON.stringify(args).slice(0, 80)})`);
            }
        }
        if (!fn.name || typeof args !== "object" || args === null || Array.isArray(args)) {
            throw malformedError(`malformed tool call from the model server: ${JSON.stringify(tc).slice(0, 120)}`);
        }
        // `type` isn't part of Ollama's format, but these calls go back to the
        // server in the next request's history, and OpenAI-style nodes reject a
        // history tool call without it ("Missing tool call type", HTTP 500).
        return { type: "function", ...tc, function: { ...fn, arguments: args } };
    });
}
/** Send a chat request streaming and reassemble the parts into the response non-streaming would have returned. */
async function chatViaStream(chat, request) {
    // Errors here are about the request itself (HTTP status, connection refused) and propagate as-is.
    const stream = await chat({ ...request, stream: true });
    let content = "";
    let thinking = "";
    const toolCalls = [];
    let last;
    try {
        for await (const part of stream) {
            content += part.message?.content ?? "";
            thinking += part.message?.thinking ?? "";
            if (part.message?.tool_calls)
                toolCalls.push(...part.message.tool_calls);
            last = part;
        }
    }
    catch (e) {
        throw new StreamInterruptedError(e);
    }
    if (!last?.done)
        throw new StreamInterruptedError(new Error("stream ended before the reply finished"));
    const calls = normalizeToolCalls(toolCalls);
    return {
        ...last,
        message: {
            role: last.message?.role ?? "assistant",
            content,
            ...(thinking ? { thinking } : {}),
            ...(calls.length ? { tool_calls: calls } : {}),
        },
    };
}
/**
 * Wrap `client.chat` so every non-streaming call is sent streaming (see the
 * header comment) and transient failures are retried with backoff. Returns
 * the same client.
 */
export function withRetries(client, opts = {}) {
    const delays = opts.delaysMs ?? DEFAULT_DELAYS_MS;
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const chat = client.chat.bind(client);
    client.chat = async (request) => {
        if (request?.stream)
            return chat(request);
        let streamed = true;
        for (let attempt = 0;; attempt++) {
            try {
                if (streamed)
                    return await chatViaStream(chat, request);
                const res = await chat(request);
                return { ...res, message: { ...res.message, tool_calls: res.message?.tool_calls && normalizeToolCalls(res.message.tool_calls) } };
            }
            catch (e) {
                if (attempt >= delays.length || !isTransient(e))
                    throw e;
                opts.onRetry?.(attempt + 1, delays.length, describeError(e));
                // A malformed tool call isn't a sick node, just one whose streaming
                // tool-call output is broken (its non-streaming output is fine): ask
                // again right away, non-streaming. Everything else waits a bit first.
                if (e instanceof StreamInterruptedError && e.malformed)
                    streamed = false;
                else
                    await sleep(delays[attempt]);
            }
        }
    };
    return client;
}
//# sourceMappingURL=retry.js.map