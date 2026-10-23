/**
 * OpenAI Chat request -> Qoder `agent_chat_generation` envelope.
 *
 * OpenCode's `openai-compatible` provider builds a standard OpenAI Chat body.
 * Qoder expects a larger agent envelope: system text is lifted out of the
 * message list, assistant tool-call turns need a non-empty content marker,
 * reasoning history is folded back into `<thinking>` tags, and the whole body
 * is WAF-encoded and COSY-signed.
 */

import crypto from "node:crypto";
import {
  buildQoderAuthHeaders,
  qoderChatUrl,
  type QoderCnEndpoints,
} from "./cosy.js";
import { DEFAULT_MAX_TOKENS } from "./models.js";
import { qoderEncodeBody } from "./qoder-encoding.js";
import { ensureIdentity, ensureJobToken } from "./session.js";

/** OpenAI content part as emitted by OpenCode. */
export interface OpenAIContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
  [key: string]: unknown;
}

/** OpenAI tool call as emitted by OpenCode. */
export interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
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

export type QoderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

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
  function: { name: string; arguments: string };
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

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/** Extract visible text from a string or OpenAI content-part array. */
export function extractText(
  content: string | OpenAIContentPart[] | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && part.type === "text" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("");
}

function imageURLOf(part: OpenAIContentPart): string {
  if (typeof part.image_url === "string") return part.image_url;
  const url = part.image_url?.url;
  return typeof url === "string" ? url : "";
}

/** Normalize user content while keeping text/image parts Qoder understands. */
function normalizeUserContent(
  content: string | OpenAIContentPart[] | null | undefined,
): string | QoderContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: QoderContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text.length > 0) parts.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const url = imageURLOf(part);
      if (url) parts.push({ type: "image_url", image_url: { url } });
    }
  }
  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text).join("");
  }
  return parts;
}

/** Strip provider-only fields (`strict`, `cache_control`) from tool schemas. */
export function normalizeQoderTools(tools: unknown): QoderWireTool[] {
  if (!Array.isArray(tools)) return [];
  const result: QoderWireTool[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : record;
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) continue;
    result.push({
      type: "function",
      function: {
        name,
        ...(typeof fn.description === "string"
          ? { description: fn.description }
          : {}),
        ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
      },
    });
  }
  return result;
}

function normalizeToolCalls(calls: unknown): QoderWireToolCall[] {
  if (!Array.isArray(calls)) return [];
  const result: QoderWireToolCall[] = [];
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const record = call as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : undefined;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) continue;
    const args =
      typeof fn?.arguments === "string"
        ? fn.arguments
        : fn?.arguments === undefined
          ? "{}"
          : JSON.stringify(fn.arguments);
    result.push({
      ...(typeof record.id === "string" ? { id: record.id } : {}),
      type: "function",
      function: { name, arguments: args },
    });
  }
  return result;
}

/**
 * Lift `system`/`developer` messages out of the conversation. Qoder carries the
 * system prompt in a dedicated envelope field.
 */
export function extractQoderSystem(messages: OpenAIMessage[]): {
  system: string;
  messages: OpenAIMessage[];
} {
  const system: string[] = [];
  const rest: OpenAIMessage[] = [];
  for (const message of messages) {
    if (message?.role === "system" || message?.role === "developer") {
      const text = extractText(message.content);
      if (text.trim().length > 0) system.push(text);
    } else {
      rest.push(message);
    }
  }
  return { system: system.join("\n\n"), messages: rest };
}

/**
 * Convert OpenAI messages to Qoder's wire vocabulary without mutating history.
 */
export function normalizeQoderMessages(
  messages: OpenAIMessage[],
): QoderWireMessage[] {
  const result: QoderWireMessage[] = [];
  for (const message of messages) {
    const role = message?.role;

    if (role === "user") {
      result.push({ role: "user", content: normalizeUserContent(message.content) });
      continue;
    }

    if (role === "assistant") {
      let text = extractText(message.content);
      const reasoning =
        typeof message.reasoning_content === "string"
          ? message.reasoning_content
          : "";
      if (reasoning.trim().length > 0) {
        text = `<thinking>${reasoning}</thinking>\n\n${text}`;
      }
      const toolCalls = normalizeToolCalls(message.tool_calls);
      result.push({
        role: "assistant",
        // Qoder rejects tool results after an assistant with null content.
        content: text || (toolCalls.length > 0 ? "(tool call)" : null),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (role === "tool" || role === "function") {
      const text = extractText(message.content) || "(no output)";
      result.push({
        role: "tool",
        tool_call_id: message.tool_call_id ?? "",
        content: text,
      });
      continue;
    }

    // Unknown roles are folded into the user stream to preserve order.
    const text = extractText(message.content);
    if (text.length > 0) result.push({ role: "user", content: text });
  }
  return result;
}

/** The last user text, used for `chat_context` and the business title. */
export function lastUserText(messages: QoderWireMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") return extractText(message.content);
  }
  return "";
}

/** Extract the requested output cap from either OpenAI field. */
export function maxTokensFromBody(body: OpenAIRequestBody): number | undefined {
  return (
    positiveInteger(body.max_tokens) ??
    positiveInteger(body.max_completion_tokens)
  );
}

/** Extract the requested reasoning effort from the OpenAI body. */
export function reasoningEffortFromBody(
  body: OpenAIRequestBody,
): string | undefined {
  return typeof body.reasoning_effort === "string" &&
    body.reasoning_effort.trim().length > 0
    ? body.reasoning_effort.trim()
    : undefined;
}

function sha16(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function isReasoningEnabled(effort: string | undefined): boolean {
  if (!effort) return false;
  return !["off", "none", "disabled", "false"].includes(effort.toLowerCase());
}

/**
 * Build the Qoder agent envelope from an OpenAI Chat body.
 */
export function buildQoderEnvelope(input: {
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
}): QoderEnvelopeResult {
  const { system, messages: rest } = extractQoderSystem(
    Array.isArray(input.messages) ? input.messages : [],
  );
  const messages = normalizeQoderMessages(rest);
  const tools = normalizeQoderTools(input.tools);
  const originalContent = lastUserText(messages);
  const maxTokens = positiveInteger(input.maxTokens) ?? DEFAULT_MAX_TOKENS;
  const reasoningEffort = input.reasoningEffort;
  const reasoningEnabled = isReasoningEnabled(reasoningEffort);

  const requestId = crypto.randomUUID();
  const sessionID = sha16([
    "qoder-session",
    input.gateway,
    input.userID,
    input.provider,
    input.model,
    input.sessionScope,
    input.kind,
  ]);
  const recordID = sha16({
    sessionID,
    model: input.model,
    messages,
    tools,
    system,
    maxTokens,
    reasoningEffort: reasoningEffort ?? null,
  });

  const body: Record<string, unknown> = {
    request_id: requestId,
    request_set_id: recordID,
    chat_record_id: recordID,
    session_id: sessionID,
    stream: true,
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system,
    messages,
    tools,
    parameters: {
      max_tokens: maxTokens,
      ...(reasoningEnabled && reasoningEffort
        ? { reasoning_effort: reasoningEffort }
        : {}),
    },
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: {
          key: input.model,
          is_reasoning: reasoningEnabled,
        },
        originalContent,
      },
      features: [],
      text: originalContent,
    },
    model_config: {
      key: input.model,
      is_reasoning: reasoningEnabled,
      max_output_tokens: maxTokens,
      source: "system",
    },
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: crypto.randomUUID(),
      name: originalContent.substring(0, 30) || "Qoder",
      begin_at: Date.now(),
    },
  };

  return {
    body,
    system,
    messages,
    tools,
    originalContent,
    maxTokens,
    reasoningEnabled,
    sessionID,
    recordID,
  };
}

/**
 * Exchange/reuse the job token, build the Qoder envelope, WAF-encode it,
 * COSY-sign it, and return a `Request` ready for the host transport.
 */
export async function buildQoderChatRequest(input: {
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
}): Promise<{ request: Request; meta: QoderRequestMeta }> {
  const jobToken = await ensureJobToken(input.pat, input.endpoints, {
    signal: input.signal,
    force: input.forceToken,
  });
  const identity = await ensureIdentity(
    input.pat,
    jobToken,
    input.endpoints,
    { signal: input.signal },
  );

  const envelope = buildQoderEnvelope({
    model: input.model,
    messages: Array.isArray(input.body.messages) ? input.body.messages : [],
    tools: input.body.tools,
    maxTokens: maxTokensFromBody(input.body),
    reasoningEffort: reasoningEffortFromBody(input.body),
    sessionScope: input.sessionScope,
    provider: input.provider,
    kind: input.kind,
    userID: identity.userID,
    gateway: input.endpoints.gateway,
  });

  const encodedBody = new TextEncoder().encode(
    qoderEncodeBody(JSON.stringify(envelope.body)),
  );
  const chatURL = qoderChatUrl(input.endpoints);
  const cosyHeaders = buildQoderAuthHeaders(encodedBody, chatURL, {
    userID: identity.userID,
    authToken: jobToken,
    name: identity.name,
    email: identity.email,
    machineID: input.machineId,
  });

  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    "Accept-Encoding": "identity",
    "X-Model-Key": input.model,
    "X-Model-Source": "system",
  };
  const requestID = crypto.randomUUID();
  baseHeaders["X-Qoder-Request-Id"] = requestID;

  const request = new Request(chatURL, {
    method: "POST",
    headers: { ...baseHeaders, ...cosyHeaders },
    body: encodedBody as unknown as BodyInit,
    signal: input.signal,
  });

  return {
    request,
    meta: {
      requestID,
      pat: input.pat,
      endpoints: input.endpoints,
      machineId: input.machineId,
      chatURL,
      encodedBody,
      baseHeaders,
      model: input.model,
      sessionID: envelope.sessionID,
      kind: input.kind,
    },
  };
}

/**
 * Re-sign an already-built request with a fresh job token. The WAF-encoded
 * body is token-independent, so a retry only needs new COSY headers.
 */
export async function resignQoderRequest(
  meta: QoderRequestMeta,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<Request> {
  const jobToken = await ensureJobToken(meta.pat, meta.endpoints, {
    signal: options.signal,
    force: options.force,
  });
  const identity = await ensureIdentity(
    meta.pat,
    jobToken,
    meta.endpoints,
    { signal: options.signal },
  );
  const cosyHeaders = buildQoderAuthHeaders(meta.encodedBody, meta.chatURL, {
    userID: identity.userID,
    authToken: jobToken,
    name: identity.name,
    email: identity.email,
    machineID: meta.machineId,
  });
  return new Request(meta.chatURL, {
    method: "POST",
    headers: { ...meta.baseHeaders, ...cosyHeaders },
    body: meta.encodedBody as unknown as BodyInit,
    signal: options.signal,
  });
}
