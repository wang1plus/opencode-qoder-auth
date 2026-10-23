import assert from "node:assert/strict";
import test from "node:test";
import {
  DONE,
  isAuthExpiredPayload,
  parseQoderEnvelope,
  peekQoderSseAuth,
  transformQoderResponse,
  transformQoderSse,
} from "../dist/stream.js";
import { QoderError } from "../dist/errors.js";

const encoder = new TextEncoder();

function envelope(inner) {
  return `data: ${JSON.stringify({
    statusCodeValue: 200,
    body: JSON.stringify(inner),
  })}\n\n`;
}

function done() {
  return `data: ${DONE}\n\n`;
}

function streamOf(...parts) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

async function collect(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function events(text) {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => block.replace(/^data:\s*/, ""))
    .map((payload) => (payload === DONE ? DONE : JSON.parse(payload)));
}

function deltas(parsed) {
  return parsed
    .filter(
      (event) =>
        event !== DONE &&
        event.choices?.length > 0 &&
        !event.choices[0].finish_reason,
    )
    .map((event) => event.choices[0].delta);
}

test("translates text deltas and a final finish reason", async () => {
  const output = await collect(
    transformQoderSse(
      streamOf(
        envelope({ choices: [{ delta: { content: "Hello" } }] }),
        envelope({
          choices: [{ delta: { content: " world" }, finish_reason: "stop" }],
        }),
        done(),
      ),
      { model: "qwen3-coder-plus" },
    ),
  );

  const parsed = events(output);
  assert.deepEqual(deltas(parsed), [
    { content: "Hello" },
    { content: " world" },
  ]);
  const finish = parsed.find(
    (event) => event !== DONE && event.choices?.[0]?.finish_reason,
  );
  assert.equal(finish.choices[0].finish_reason, "stop");
  assert.equal(parsed.at(-1), DONE);
  assert.match(output, /data: \[DONE\]\n\n$/);
});

test("translates native reasoning_content deltas", async () => {
  const output = await collect(
    transformQoderSse(
      streamOf(
        envelope({ choices: [{ delta: { reasoning_content: "think" } }] }),
        envelope({ choices: [{ delta: { content: "answer" } }] }),
        done(),
      ),
      { model: "qwen3-coder-plus" },
    ),
  );
  const parsed = events(output);
  assert.deepEqual(deltas(parsed), [
    { reasoning_content: "think" },
    { content: "answer" },
  ]);
});

test("extracts tagged reasoning from visible content", async () => {
  const output = await collect(
    transformQoderSse(
      streamOf(
        envelope({
          choices: [
            { delta: { content: "<thinking>plan</thinking>\n\nanswer" } },
          ],
        }),
        done(),
      ),
      { model: "qwen3-coder-plus" },
    ),
  );
  const parsed = events(output);
  assert.deepEqual(deltas(parsed), [
    { reasoning_content: "plan" },
    { content: "\n\nanswer" },
  ]);
});

test("translates tool-call deltas and infers tool_calls finish", async () => {
  const output = await collect(
    transformQoderSse(
      streamOf(
        envelope({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    function: { name: "read", arguments: '{"path"' },
                  },
                ],
              },
            },
          ],
        }),
        envelope({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }],
              },
            },
          ],
        }),
        envelope({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        done(),
      ),
      { model: "qwen3-coder-plus" },
    ),
  );
  const parsed = events(output);
  const toolDeltas = deltas(parsed).filter((delta) => delta.tool_calls);
  assert.equal(toolDeltas.length, 2);
  assert.deepEqual(toolDeltas[0].tool_calls[0], {
    index: 0,
    id: "call-1",
    function: { name: "read", arguments: '{"path"' },
  });
  assert.deepEqual(toolDeltas[1].tool_calls[0], {
    index: 0,
    function: { arguments: '"a.txt"}' },
  });
  const finish = parsed.find(
    (event) => event !== DONE && event.choices?.[0]?.finish_reason,
  );
  assert.equal(finish.choices[0].finish_reason, "tool_calls");
  assert.equal(parsed.at(-1), DONE);
});

test("surfaces an upstream auth envelope as an error event then DONE", async () => {
  const output = await collect(
    transformQoderSse(
      streamOf(
        `data: ${JSON.stringify({
          statusCodeValue: 403,
          body: JSON.stringify({ code: "105", message: "Login expired" }),
        })}\n\n`,
      ),
      { model: "qwen3-coder-plus" },
    ),
  );
  const parsed = events(output);
  assert.equal(parsed[0].error.message, "Login expired");
  assert.equal(parsed[0].error.code, "105");
  assert.equal(parsed.at(-1), DONE);
});

test("rejects reasoning-only and empty completed responses", async () => {
  const reasoningOnly = await collect(
    transformQoderSse(
      streamOf(
        envelope({
          choices: [{ delta: { content: "<thinking>plan</thinking>" } }],
        }),
        envelope({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        done(),
      ),
      { model: "qwen3-coder-plus" },
    ),
  );
  const reasoningEvents = events(reasoningOnly);
  assert.equal(
    reasoningEvents.find((event) => event.error)?.error.code,
    "QODER_INCOMPLETE_RESPONSE",
  );
  assert.equal(reasoningEvents.at(-1), DONE);

  const empty = await collect(
    transformQoderSse(
      streamOf(
        envelope({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        done(),
      ),
      { model: "qwen3-coder-plus" },
    ),
  );
  const emptyEvents = events(empty);
  assert.equal(
    emptyEvents.find((event) => event.error)?.error.code,
    "QODER_EMPTY_RESPONSE",
  );
  assert.equal(emptyEvents.at(-1), DONE);
});

test("treats a clean EOF after data as a normal finish", async () => {
  const output = await collect(
    transformQoderSse(
      streamOf(envelope({ choices: [{ delta: { content: "done" } }] })),
      { model: "qwen3-coder-plus" },
    ),
  );
  const parsed = events(output);
  assert.equal(parsed.at(-1), DONE);
  assert.equal(
    parsed.find(
      (event) => event !== DONE && event.choices?.[0]?.finish_reason,
    ).choices[0].finish_reason,
    "stop",
  );
});

test("reports an empty stream and a malformed envelope", async () => {
  const empty = await collect(
    transformQoderSse(streamOf(), { model: "qwen3-coder-plus" }),
  );
  const emptyEvents = events(empty);
  assert.equal(
    emptyEvents.find((event) => event.error)?.error.code,
    "QODER_STREAM_CLOSED",
  );
  assert.equal(emptyEvents.at(-1), DONE);

  const malformed = await collect(
    transformQoderSse(streamOf("data: not-json\n\n"), {
      model: "qwen3-coder-plus",
    }),
  );
  const malformedEvents = events(malformed);
  assert.equal(
    malformedEvents.find((event) => event.error)?.error.code,
    "MALFORMED_RESPONSE",
  );
  assert.equal(malformedEvents.at(-1), DONE);
});

test("parses envelopes and detects auth-expiry payloads", () => {
  assert.deepEqual(
    parseQoderEnvelope(JSON.stringify({ statusCodeValue: 200, body: "{}" })),
    { statusCodeValue: 200, body: "{}" },
  );
  assert.throws(
    () => parseQoderEnvelope("nope"),
    (error) => error instanceof QoderError && error.code === "MALFORMED_RESPONSE",
  );

  assert.equal(isAuthExpiredPayload(DONE), false);
  assert.equal(
    isAuthExpiredPayload(JSON.stringify({ statusCodeValue: 401, body: "" })),
    true,
  );
  assert.equal(
    isAuthExpiredPayload(
      JSON.stringify({
        statusCodeValue: 200,
        body: JSON.stringify({ code: "105", message: "Login expired" }),
      }),
    ),
    true,
  );
  assert.equal(
    isAuthExpiredPayload(
      JSON.stringify({
        statusCodeValue: 200,
        body: JSON.stringify({ error: { code: 105 } }),
      }),
    ),
    true,
  );
  assert.equal(
    isAuthExpiredPayload(
      JSON.stringify({
        statusCodeValue: 200,
        body: JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
      }),
    ),
    false,
  );
});

test("peeks auth expiry without losing any replayed bytes", async () => {
  const authFrame = `data: ${JSON.stringify({
    statusCodeValue: 403,
    body: JSON.stringify({ code: "105", message: "Login expired" }),
  })}\n\n`;
  const normalFrame = envelope({
    choices: [{ delta: { content: "hello" } }],
  });
  const original = authFrame + normalFrame;

  const response = new Response(streamOf(original), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const peeked = await peekQoderSseAuth(response);
  assert.equal(peeked.authExpired, true);
  assert.equal(await collect(peeked.response.body), original);

  const normal = new Response(streamOf(normalFrame), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const notAuth = await peekQoderSseAuth(normal);
  assert.equal(notAuth.authExpired, false);
  assert.equal(await collect(notAuth.response.body), normalFrame);

  const split = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(authFrame.slice(0, 20)));
        controller.enqueue(encoder.encode(authFrame.slice(20)));
        controller.close();
      },
    }),
    { status: 200 },
  );
  const splitPeek = await peekQoderSseAuth(split);
  assert.equal(splitPeek.authExpired, true);
  assert.equal(await collect(splitPeek.response.body), authFrame);
});

test("wraps a response with an OpenAI SSE content type", async () => {
  const response = new Response(
    streamOf(
      envelope({ choices: [{ delta: { content: "hi" } }] }),
      done(),
    ),
    { status: 200, headers: { "content-type": "text/plain" } },
  );
  const wrapped = transformQoderResponse(response, {
    model: "qwen3-coder-plus",
  });
  assert.match(wrapped.headers.get("content-type"), /text\/event-stream/);
  const parsed = events(await collect(wrapped.body));
  assert.deepEqual(deltas(parsed), [{ content: "hi" }]);
  assert.equal(parsed.at(-1), DONE);
});
