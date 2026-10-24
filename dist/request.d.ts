/**
 * OpenAI Chat request -> Qoder `agent_chat_generation` envelope.
 *
 * OpenCode's `openai-compatible` provider builds a standard OpenAI Chat body.
 * Qoder expects a larger agent envelope: system text is lifted out of the
 * message list, assistant tool-call turns need a non-empty content marker,
 * reasoning history is folded back into `<thinking>` tags, and the whole body
 * is WAF-encoded and COSY-signed.
 */
import { type QoderCnEndpoints } from "./cosy.js";
/** OpenAI content part as emitted by OpenCode. */
export interface OpenAIContentPart {
    type?: string;
    text?: string;
    image_url?: {
        url?: string;
    } | string;
    [key: string]: unknown;
}
/** OpenAI tool call as emitted by OpenCode. */
export interface OpenAIToolCall {
    id?: string;
    type?: string;
    function?: {
        name?: string;
        arguments?: string;
    };
    [key: string]: unknown;
}
/** OpenAI message as emitted by OpenCode. */
export interface OpenAIMessage {
    role?: string;
    content?: string | OpenAIContentPart[] | null;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    reasoning_content?: string;
    [key: string]: unknown;
}
/** OpenAI Chat request body. */
export interface OpenAIRequestBody {
    model?: string;
    messages?: OpenAIMessage[];
    tools?: unknown;
    max_tokens?: number;
    max_completion_tokens?: number;
    reasoning_effort?: string;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    [key: string]: unknown;
}
export type QoderContentPart = {
    type: "text";
    text: string;
} | {
    type: "image_url";
    image_url: {
        url: string;
    };
};
/** OpenAI-style tool definition sent to Qoder. */
export interface QoderWireTool {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: unknown;
    };
}
/** OpenAI-style tool call within an assistant message. */
export interface QoderWireToolCall {
    id?: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
/** OpenAI-style message sent to Qoder. */
export interface QoderWireMessage {
    role: "user" | "assistant" | "tool";
    content: string | QoderContentPart[] | null;
    tool_calls?: QoderWireToolCall[];
    tool_call_id?: string;
}
/** Fully built envelope plus the bookkeeping used by the response transformer. */
export interface QoderEnvelopeResult {
    body: Record<string, unknown>;
    system: string;
    messages: QoderWireMessage[];
    tools: QoderWireTool[];
    originalContent: string;
    maxTokens: number;
    reasoningEnabled: boolean;
    sessionID: string;
    recordID: string;
}
/** Metadata retained for one in-flight request so auth expiry can be retried. */
export interface QoderRequestMeta {
    /** Correlation id carried as `X-Qoder-Request-Id` and used by the response hook. */
    requestID: string;
    pat: string;
    endpoints: QoderCnEndpoints;
    machineId: string;
    chatURL: string;
    encodedBody: Uint8Array;
    baseHeaders: Record<string, string>;
    model: string;
    sessionID: string;
    kind: string;
    /** Set once the request has been retried after an auth-expiry response. */
    retried?: boolean;
}
/** Extract visible text from a string or OpenAI content-part array. */
export declare function extractText(content: string | OpenAIContentPart[] | null | undefined): string;
/** Strip provider-only fields (`strict`, `cache_control`) from tool schemas. */
export declare function normalizeQoderTools(tools: unknown): QoderWireTool[];
/**
 * Lift `system`/`developer` messages out of the conversation. Qoder carries the
 * system prompt in a dedicated envelope field.
 */
export declare function extractQoderSystem(messages: OpenAIMessage[]): {
    system: string;
    messages: OpenAIMessage[];
};
/**
 * Convert OpenAI messages to Qoder's wire vocabulary without mutating history.
 */
export declare function normalizeQoderMessages(messages: OpenAIMessage[]): QoderWireMessage[];
/** The last user text, used for `chat_context` and the business title. */
export declare function lastUserText(messages: QoderWireMessage[]): string;
/** Extract the requested output cap from either OpenAI field. */
export declare function maxTokensFromBody(body: OpenAIRequestBody): number | undefined;
/** Extract the requested reasoning effort from the OpenAI body. */
export declare function reasoningEffortFromBody(body: OpenAIRequestBody): string | undefined;
/**
 * Build the Qoder agent envelope from an OpenAI Chat body.
 */
export declare function buildQoderEnvelope(input: {
    model: string;
    messages: OpenAIMessage[];
    tools?: unknown;
    maxTokens?: number;
    reasoningEffort?: string;
    sessionScope: string;
    provider: string;
    kind: string;
    userID: string;
    gateway: string;
}): QoderEnvelopeResult;
/**
 * Exchange/reuse the job token, build the Qoder envelope, WAF-encode it,
 * COSY-sign it, and return a `Request` ready for the host transport.
 */
export declare function buildQoderChatRequest(input: {
    pat: string;
    endpoints: QoderCnEndpoints;
    machineId: string;
    model: string;
    body: OpenAIRequestBody;
    sessionScope: string;
    provider: string;
    kind: string;
    signal?: AbortSignal;
    forceToken?: boolean;
}): Promise<{
    request: Request;
    meta: QoderRequestMeta;
}>;
/**
 * Re-sign an already-built request with a fresh job token. The WAF-encoded
 * body is token-independent, so a retry only needs new COSY headers.
 */
export declare function resignQoderRequest(meta: QoderRequestMeta, options?: {
    signal?: AbortSignal;
    force?: boolean;
}): Promise<Request>;
