/**
 * Qoder double-enveloped SSE -> standard OpenAI Chat SSE.
 *
 * Qoder streams `data: {"statusCodeValue":200,"body":"<JSON string>"}` frames
 * whose inner body is an OpenAI-style chunk. OpenCode's OpenAI Chat protocol
 * expects ordinary `data: {choices:[...]}` frames and a final `[DONE]`, so this
 * module unwraps the envelope, extracts tagged reasoning, normalizes tool-call
 * deltas, and guards incomplete/empty generations.
 */
import crypto from "node:crypto";
import { QoderError, errorCodeOf, upstreamErrorDetail, } from "./errors.js";
import { ThinkingParser } from "./thinking-parser.js";
export const DONE = "[DONE]";
/**
 * Decode one SSE `data:` payload into the envelope.
 */
export function parseQoderEnvelope(data) {
    try {
        const parsed = JSON.parse(data);
        const statusCodeValue = typeof parsed.statusCodeValue === "number" ? parsed.statusCodeValue : 200;
        return { statusCodeValue, body: parsed.body };
    }
    catch {
        throw new QoderError(`malformed Qoder SSE envelope: ${data.slice(0, 120)}`, { code: "MALFORMED_RESPONSE" });
    }
}
function recordOf(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function codeOf(value) {
    const record = recordOf(value);
    const code = record?.code;
    return typeof code === "string" || typeof code === "number"
        ? code
        : undefined;
}
/**
 * True when an SSE payload is an auth-expiry envelope (`401/403`, or an
 * in-band `code 105` login-expired body).
 */
export function isAuthExpiredPayload(payload) {
    if (payload === DONE)
        return false;
    try {
        const envelope = JSON.parse(payload);
        if (envelope.statusCodeValue === 401 || envelope.statusCodeValue === 403) {
            return true;
        }
        const body = envelope.body;
        if (typeof body === "string") {
            if (/"code"\s*:\s*"?105"?/.test(body))
                return true;
            const nested = recordOf(JSON.parse(body));
            return isCode105(codeOf(nested)) || isCode105(codeOf(nested?.error));
        }
        const record = recordOf(body);
        return isCode105(codeOf(record)) || isCode105(codeOf(record?.error));
    }
    catch {
        return false;
    }
}
function isCode105(code) {
    return code !== undefined && String(code) === "105";
}
function reconstructResponse(response, stream) {
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
async function pump(reader, controller) {
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                controller.close();
                return;
            }
            controller.enqueue(value);
        }
    }
    catch (error) {
        controller.error(error);
    }
}
/**
 * Read just enough of a Qoder SSE response to decide whether the first frame is
 * an auth-expiry error, then return a response that replays every byte.
 */
export async function peekQoderSseAuth(response) {
    if (!response.body)
        return { response, authExpired: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let payload;
    let done = false;
    try {
        while (payload === undefined) {
            const result = await reader.read();
            if (result.done) {
                done = true;
                break;
            }
            chunks.push(result.value);
            text += decoder.decode(result.value, { stream: true });
            // Wait for a complete line before decoding: the first network chunk may
            // split the `data:` JSON payload in half.
            if (!text.includes("\n"))
                continue;
            for (const line of text.split("\n")) {
                const trimmed = line.replace(/\r$/, "");
                if (trimmed.startsWith("data:")) {
                    payload = trimmed.slice(5).trim();
                    break;
                }
            }
        }
        if (payload === undefined && text.length > 0) {
            for (const line of text.split("\n")) {
                const trimmed = line.replace(/\r$/, "");
                if (trimmed.startsWith("data:")) {
                    payload = trimmed.slice(5).trim();
                    break;
                }
            }
        }
    }
    catch (error) {
        const stream = new ReadableStream({
            start(controller) {
                controller.error(error);
            },
        });
        return { response: reconstructResponse(response, stream), authExpired: false };
    }
    const stream = new ReadableStream({
        start(controller) {
            for (const chunk of chunks)
                controller.enqueue(chunk);
            if (done) {
                controller.close();
                return;
            }
            void pump(reader, controller);
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
    return {
        response: reconstructResponse(response, stream),
        authExpired: payload !== undefined && isAuthExpiredPayload(payload),
    };
}
function normalizeFinishReason(reason) {
    switch (reason) {
        case "stop":
        case "end":
            return "stop";
        case "length":
            return "length";
        case "tool_calls":
        case "function_call":
            return "tool_calls";
        case "content_filter":
            return "content_filter";
        case "error":
        case "network_error":
            return "error";
        default:
            return "stop";
    }
}
function normalizeUsage(usage) {
    if (!usage || typeof usage !== "object")
        return undefined;
    const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
    const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
    const total = typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : prompt + completion;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: total,
    };
}
function toolCallDelta(call, position) {
    const fn = call.function;
    return {
        index: typeof call.index === "number" ? call.index : position,
        ...(typeof call.id === "string" && call.id.length > 0
            ? { id: call.id }
            : {}),
        function: {
            ...(typeof fn?.name === "string" && fn.name.length > 0
                ? { name: fn.name }
                : {}),
            ...(typeof fn?.arguments === "string"
                ? { arguments: fn.arguments }
                : {}),
        },
    };
}
/**
 * Transform a Qoder SSE byte stream into standard OpenAI Chat SSE.
 */
export function transformQoderSse(body, options) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const id = options.id ??
        `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const created = options.created ?? Math.floor(Date.now() / 1000);
    const model = options.model || "qoder";
    return new ReadableStream({
        async start(controller) {
            const reader = body.getReader();
            let buffer = "";
            let terminal = false;
            let sawPayload = false;
            let finishReason;
            let usage;
            let hasVisibleText = false;
            let hasReasoning = false;
            let hasToolCalls = false;
            const thinking = new ThinkingParser();
            const enqueue = (bytes) => {
                if (terminal)
                    return;
                try {
                    controller.enqueue(bytes);
                }
                catch {
                    terminal = true;
                }
            };
            // The terminal sentinel must still reach the consumer after `terminal`
            // is set, so it bypasses the guard above.
            const emitDone = () => {
                try {
                    controller.enqueue(encoder.encode(`data: ${DONE}\n\n`));
                }
                catch {
                    // The consumer may already have cancelled; nothing left to emit.
                }
            };
            const emitData = (data) => {
                enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            };
            const emitDelta = (delta) => {
                emitData({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta, finish_reason: null }],
                });
            };
            const emitError = (message, code) => {
                emitData({
                    error: {
                        message,
                        ...(code === undefined ? {} : { code }),
                    },
                });
            };
            const emitPieces = (pieces) => {
                for (const piece of pieces) {
                    if (piece.kind === "reasoning") {
                        hasReasoning = true;
                        emitDelta({ reasoning_content: piece.text });
                    }
                    else {
                        if (piece.text.trim().length > 0)
                            hasVisibleText = true;
                        emitDelta({ content: piece.text });
                    }
                }
            };
            const finishStream = () => {
                if (terminal)
                    return;
                emitPieces(thinking.flush());
                let reason = finishReason === undefined
                    ? hasToolCalls
                        ? "tool_calls"
                        : "stop"
                    : normalizeFinishReason(finishReason);
                if (reason === "error") {
                    emitError("Qoder reported an error finish_reason", "QODER_FINISH_ERROR");
                    terminal = true;
                    emitDone();
                    return;
                }
                if (reason === "tool_calls" && !hasToolCalls) {
                    emitError("Qoder returned an incomplete response without a structured tool call", "QODER_INCOMPLETE_RESPONSE");
                    terminal = true;
                    emitDone();
                    return;
                }
                if (reason === "stop" && !hasToolCalls && !hasVisibleText) {
                    emitError(hasReasoning || thinking.hasThinking
                        ? "Qoder returned an incomplete response without a final answer or structured tool call"
                        : "Qoder returned a completed response with no content", hasReasoning || thinking.hasThinking
                        ? "QODER_INCOMPLETE_RESPONSE"
                        : "QODER_EMPTY_RESPONSE");
                    terminal = true;
                    emitDone();
                    return;
                }
                if (usage) {
                    emitData({
                        id,
                        object: "chat.completion.chunk",
                        created,
                        model,
                        choices: [],
                        usage,
                    });
                }
                reason = reason === "stop" && hasToolCalls ? "tool_calls" : reason;
                emitData({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: reason }],
                });
                terminal = true;
                emitDone();
            };
            const processInner = (inner) => {
                if (inner.error) {
                    emitError(typeof inner.error.message === "string" && inner.error.message
                        ? inner.error.message
                        : "Qoder returned an error", inner.error.code ?? "QODER_ERROR");
                    terminal = true;
                    emitDone();
                    return true;
                }
                for (const choice of inner.choices ?? []) {
                    const delta = choice.delta;
                    if (!delta) {
                        if (typeof choice.finish_reason === "string") {
                            finishReason = choice.finish_reason;
                        }
                        continue;
                    }
                    const nativeReasoning = delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text;
                    if (typeof nativeReasoning === "string" && nativeReasoning.length > 0) {
                        hasReasoning = true;
                        emitDelta({ reasoning_content: nativeReasoning });
                    }
                    if (typeof delta.content === "string" && delta.content.length > 0) {
                        emitPieces(thinking.feed(delta.content));
                    }
                    if (Array.isArray(delta.tool_calls)) {
                        const calls = delta.tool_calls
                            .filter((call) => typeof call === "object" && call !== null)
                            .map((call, position) => toolCallDelta(call, position));
                        if (calls.length > 0) {
                            hasToolCalls = true;
                            emitDelta({ tool_calls: calls });
                        }
                    }
                    if (typeof choice.finish_reason === "string") {
                        finishReason = choice.finish_reason;
                    }
                }
                const mappedUsage = normalizeUsage(inner.usage);
                if (mappedUsage)
                    usage = mappedUsage;
                return false;
            };
            const processPayload = (payload) => {
                if (payload === DONE) {
                    finishStream();
                    return true;
                }
                let envelope;
                try {
                    envelope = parseQoderEnvelope(payload);
                }
                catch (error) {
                    emitError(error instanceof Error
                        ? error.message
                        : "malformed Qoder SSE envelope", "MALFORMED_RESPONSE");
                    terminal = true;
                    emitDone();
                    return true;
                }
                if (envelope.statusCodeValue !== 200) {
                    const status = envelope.statusCodeValue;
                    const detail = typeof envelope.body === "string"
                        ? envelope.body
                        : envelope.body === undefined
                            ? ""
                            : JSON.stringify(envelope.body);
                    emitError(upstreamErrorDetail(detail) ||
                        `Qoder upstream status ${status}`, errorCodeOf(detail) ?? (status >= 100 && status <= 599 ? status : undefined));
                    terminal = true;
                    emitDone();
                    return true;
                }
                let inner;
                if (typeof envelope.body === "string") {
                    if (envelope.body === DONE)
                        return false;
                    try {
                        inner = JSON.parse(envelope.body);
                    }
                    catch {
                        emitError(`malformed Qoder inner chunk: ${envelope.body.slice(0, 120)}`, "MALFORMED_RESPONSE");
                        terminal = true;
                        emitDone();
                        return true;
                    }
                }
                else {
                    inner = recordOf(envelope.body) ?? {};
                }
                return processInner(inner);
            };
            let stopped = false;
            try {
                while (!stopped) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    buffer += decoder.decode(value, { stream: true });
                    let lineEnd = buffer.indexOf("\n");
                    while (lineEnd !== -1) {
                        const line = buffer.slice(0, lineEnd).replace(/\r$/, "").trim();
                        buffer = buffer.slice(lineEnd + 1);
                        if (line.startsWith("data:")) {
                            sawPayload = true;
                            if (processPayload(line.slice(5).trim())) {
                                stopped = true;
                                break;
                            }
                        }
                        lineEnd = buffer.indexOf("\n");
                    }
                }
                if (!stopped) {
                    buffer += decoder.decode();
                    const tail = buffer.replace(/\r$/, "").trim();
                    if (tail.startsWith("data:")) {
                        sawPayload = true;
                        processPayload(tail.slice(5).trim());
                    }
                    if (!terminal) {
                        if (sawPayload) {
                            finishStream();
                        }
                        else {
                            emitError("Qoder SSE stream ended without any data", "QODER_STREAM_CLOSED");
                            terminal = true;
                            emitDone();
                        }
                    }
                }
            }
            catch (error) {
                if (!terminal) {
                    emitError(error instanceof Error ? error.message : "Qoder stream failed", "QODER_STREAM_ERROR");
                    terminal = true;
                    emitDone();
                }
            }
            finally {
                reader.releaseLock();
                controller.close();
            }
        },
    });
}
/**
 * Wrap a Qoder HTTP response as an OpenAI Chat SSE response.
 */
export function transformQoderResponse(response, options) {
    if (!response.body)
        return response;
    const headers = new Headers(response.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(transformQoderSse(response.body, options), {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
