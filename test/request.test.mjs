import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQoderChatRequest,
  buildQoderEnvelope,
  extractQoderSystem,
  normalizeQoderMessages,
  normalizeQoderTools,
  resignQoderRequest,
} from "../dist/request.js";
import { qoderDecodeBody } from "../dist/qoder-encoding.js";
import { qoderChatUrl, qoderCnEndpoints } from "../dist/cosy.js";
import { clearQoderSessionCaches } from "../dist/session.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetch(mock, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  clearQoderSessionCaches();
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
    clearQoderSessionCaches();
  }
}

test("lifts system/developer messages into the dedicated system field", () => {
  const { system, messages } = extractQoderSystem([
    { role: "system", content: "You are helpful." },
    { role: "developer", content: "Be concise." },
    { role: "user", content: "hello" },
  ]);
  assert.equal(system, "You are helpful.\n\nBe concise.");
  assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
});

test("normalizes user content parts and preserves images", () => {
  const messages = normalizeQoderMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    },
    { role: "user", content: [{ type: "text", text: "plain" }] },
  ]);
  assert.deepEqual(messages[0].content, [
    { type: "text", text: "look at this" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
  ]);
  assert.equal(messages[1].content, "plain");
});

test("folds reasoning and tool calls into assistant wire messages", () => {
  const messages = normalizeQoderMessages([
    {
      role: "assistant",
      content: "answer",
      reasoning_content: "plan",
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "read", arguments: '{"path":"a.txt"}' },
        },
      ],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call-2",
          type: "function",
          function: { name: "read", arguments: '{"path":"b.txt"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call-1", content: "" },
  ]);

  assert.equal(messages[0].content, "<thinking>plan</thinking>\n\nanswer");
  assert.deepEqual(messages[0].tool_calls, [
    {
      id: "call-1",
      type: "function",
      function: { name: "read", arguments: '{"path":"a.txt"}' },
    },
  ]);
  assert.equal(messages[1].content, "(tool call)");
  assert.equal(messages[1].tool_calls[0].id, "call-2");
  assert.deepEqual(messages[2], {
    role: "tool",
    tool_call_id: "call-1",
    content: "(no output)",
  });
});

test("normalizes tool schemas and strips provider-only fields", () => {
  assert.deepEqual(
    normalizeQoderTools([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object" },
          strict: false,
          cache_control: { type: "ephemeral" },
        },
      },
      { name: "flat", parameters: { type: "object" } },
      { type: "function", function: {} },
    ]),
    [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object" },
        },
      },
      {
        type: "function",
        function: { name: "flat", parameters: { type: "object" } },
      },
    ],
  );
});

test("builds the Qoder agent envelope", () => {
  const envelope = buildQoderEnvelope({
    model: "qwen3-coder-plus",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "read", parameters: { type: "object" } },
      },
    ],
    maxTokens: 4096,
    reasoningEffort: "high",
    sessionScope: "session-1",
    provider: "qoder",
    kind: "primary",
    userID: "user-1",
    gateway: "https://gateway.qoder.com.cn",
  });

  assert.equal(envelope.body.stream, true);
  assert.equal(envelope.body.chat_task, "FREE_INPUT");
  assert.equal(envelope.body.session_type, "qodercli");
  assert.equal(envelope.body.agent_id, "agent_common");
  assert.equal(envelope.body.system, "You are helpful.");
  assert.deepEqual(envelope.body.messages, [{ role: "user", content: "hello" }]);
  assert.equal(envelope.body.tools[0].function.name, "read");
  assert.deepEqual(envelope.body.parameters, {
    max_tokens: 4096,
    reasoning_effort: "high",
  });
  assert.deepEqual(envelope.body.model_config, {
    key: "qwen3-coder-plus",
    is_reasoning: true,
    max_output_tokens: 4096,
    source: "system",
  });
  assert.equal(envelope.body.chat_context.text, "hello");
  assert.equal(envelope.body.chat_context.extra.originalContent, "hello");
  assert.equal(envelope.body.request_set_id, envelope.body.chat_record_id);
  assert.notEqual(envelope.body.request_id, envelope.recordID);
  assert.equal(envelope.sessionID, envelope.body.session_id);
  assert.equal(envelope.recordID, envelope.body.chat_record_id);

  const again = buildQoderEnvelope({
    model: "qwen3-coder-plus",
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "hello" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "read", parameters: { type: "object" } },
      },
    ],
    maxTokens: 4096,
    reasoningEffort: "high",
    sessionScope: "session-1",
    provider: "qoder",
    kind: "primary",
    userID: "user-1",
    gateway: "https://gateway.qoder.com.cn",
  });
  assert.equal(again.sessionID, envelope.sessionID);
  assert.equal(again.recordID, envelope.recordID);

  const otherSession = buildQoderEnvelope({
    model: "qwen3-coder-plus",
    messages: [{ role: "user", content: "hello" }],
    sessionScope: "session-2",
    provider: "qoder",
    kind: "primary",
    userID: "user-1",
    gateway: "https://gateway.qoder.com.cn",
  });
  assert.notEqual(otherSession.sessionID, envelope.sessionID);
});

test("builds a WAF-encoded, COSY-signed chat request", async () => {
  const endpoints = qoderCnEndpoints();
  let exchanges = 0;
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/jobToken/exchange")) {
        exchanges++;
        return jsonResponse({
          token: "jt-1",
          refresh_token: "jrt-1",
          expires_in: 86_400_000,
        });
      }
      if (String(url).endsWith("/userinfo")) {
        return jsonResponse({ id: "user-1", email: "u@example.com", name: "User" });
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const { request, meta } = await buildQoderChatRequest({
        pat: "pt-test",
        endpoints,
        machineId: "machine-1",
        model: "qwen3-coder-plus",
        body: {
          model: "qwen3-coder-plus",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "hello" },
          ],
          max_tokens: 2048,
          reasoning_effort: "medium",
        },
        sessionScope: "session-1",
        provider: "qoder",
        kind: "primary",
      });

      assert.equal(request.method, "POST");
      assert.equal(request.url, qoderChatUrl(endpoints));
      assert.match(
        request.headers.get("authorization"),
        /^Bearer COSY\./,
      );
      assert.equal(request.headers.get("x-model-key"), "qwen3-coder-plus");
      assert.equal(request.headers.get("x-qoder-request-id"), meta.requestID);
      assert.equal(meta.pat, "pt-test");
      assert.equal(meta.model, "qwen3-coder-plus");
      assert.equal(meta.chatURL, qoderChatUrl(endpoints));
      assert.equal(meta.retried, undefined);

      const encoded = await request.text();
      const decoded = JSON.parse(qoderDecodeBody(encoded));
      assert.equal(decoded.system, "You are helpful.");
      assert.deepEqual(decoded.messages, [{ role: "user", content: "hello" }]);
      assert.equal(decoded.parameters.max_tokens, 2048);
      assert.equal(decoded.parameters.reasoning_effort, "medium");
      assert.equal(decoded.model_config.key, "qwen3-coder-plus");
      assert.equal(exchanges, 1);
    },
  );
});

test("re-signs the same body with a fresh job token", async () => {
  const endpoints = qoderCnEndpoints();
  let exchanges = 0;
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/jobToken/exchange")) {
        exchanges++;
        return jsonResponse({
          token: `jt-${exchanges}`,
          refresh_token: `jrt-${exchanges}`,
          expires_in: 86_400_000,
        });
      }
      if (String(url).endsWith("/userinfo")) {
        return jsonResponse({ id: "user-1", email: "u@example.com", name: "User" });
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const { request, meta } = await buildQoderChatRequest({
        pat: "pt-test",
        endpoints,
        machineId: "machine-1",
        model: "qwen3-coder-plus",
        body: {
          model: "qwen3-coder-plus",
          messages: [{ role: "user", content: "hello" }],
        },
        sessionScope: "session-1",
        provider: "qoder",
        kind: "primary",
      });
      const originalBody = await request.text();
      const originalAuth = request.headers.get("authorization");

      const resigned = await resignQoderRequest(meta, { force: true });
      assert.equal(exchanges, 2);
      assert.equal(await resigned.text(), originalBody);
      assert.notEqual(resigned.headers.get("authorization"), originalAuth);
      assert.equal(
        resigned.headers.get("x-qoder-request-id"),
        meta.requestID,
      );
    },
  );
});
