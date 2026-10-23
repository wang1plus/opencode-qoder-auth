import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  fetchQoderModelCatalog,
  parseQoderModelCatalog,
  qoderModelToInfo,
} from "../dist/models.js";
import { qoderCnEndpoints } from "../dist/cosy.js";
import { clearQoderSessionCaches } from "../dist/session.js";

const CATALOG = {
  chat: [
    {
      key: "qwen3-coder-plus",
      display_name: "Qwen3 Coder Plus",
      enable: true,
      is_reasoning: true,
      is_vl: false,
      max_output_tokens: 65536,
      context_config: {
        default: { token_count: 200000, is_default: true },
        large: { token_count: 1000000 },
      },
      thinking_config: {
        enabled: {
          efforts: {
            low: true,
            medium: { is_default: true },
            high: true,
          },
        },
      },
    },
    {
      key: "vision-model",
      display_name: "Vision Model",
      enable: true,
      is_vl: true,
      context_config: {
        default: { token_count: 128000, is_default: true },
      },
    },
    { key: "disabled-model", enable: false },
    { key: "qwen3-coder-plus", enable: true },
    { display_name: "missing key", enable: true },
  ],
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("parses the Qoder model catalog and ignores invalid entries", () => {
  const models = parseQoderModelCatalog(CATALOG);
  assert.equal(models.length, 2);

  const [reasoning, vision] = models;
  assert.equal(reasoning.id, "qwen3-coder-plus");
  assert.equal(reasoning.name, "Qwen3 Coder Plus");
  assert.equal(reasoning.contextWindow, 200000);
  assert.equal(reasoning.maxTokens, 65536);
  assert.deepEqual(reasoning.inputModalities, ["text"]);
  assert.equal(reasoning.reasoning, true);
  assert.deepEqual(reasoning.reasoningEfforts, ["low", "medium", "high"]);
  assert.equal(reasoning.defaultEffort, "medium");

  assert.equal(vision.id, "vision-model");
  assert.deepEqual(vision.inputModalities, ["text", "image"]);
  assert.equal(vision.reasoning, false);
});

test("rejects a catalog with no usable models", () => {
  assert.throws(() => parseQoderModelCatalog({}), /no "chat" array/);
  assert.throws(
    () => parseQoderModelCatalog({ chat: [{ key: "off", enable: false }] }),
    /no enabled usable models/,
  );
});

test("maps catalog entries to OpenCode model definitions", () => {
  const models = parseQoderModelCatalog(CATALOG);
  const reasoning = qoderModelToInfo(models[0], "qoder");

  assert.equal(reasoning.id, "qwen3-coder-plus");
  assert.equal(reasoning.name, "Qwen3 Coder Plus");
  assert.deepEqual(reasoning.limit, { context: 200000, output: 65536 });
  assert.deepEqual(reasoning.capabilities, {
    tools: true,
    input: ["text"],
    output: ["text"],
  });
  assert.equal(
    reasoning.compatibility?.reasoningField,
    "reasoning_content",
  );
  assert.equal(reasoning.settings?.reasoningEffort, "medium");
  assert.deepEqual(
    reasoning.variants.map((variant) => variant.id),
    ["off", "low", "medium", "high"],
  );
  assert.deepEqual(reasoning.variants[3].settings, { reasoningEffort: "high" });

  const vision = qoderModelToInfo(models[1], "qoder");
  assert.equal(vision.compatibility?.reasoningField, undefined);
  assert.equal(vision.settings?.reasoningEffort, undefined);
  assert.deepEqual(vision.variants, []);
  assert.deepEqual(vision.capabilities.input, ["text", "image"]);
});

test("falls back to default limits when the catalog omits them", () => {
  const [model] = parseQoderModelCatalog({
    chat: [{ key: "minimal", enable: true }],
  });
  assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(model.maxTokens, DEFAULT_MAX_TOKENS);
});

test("fetches the live catalog with a COSY-signed model-list request", async () => {
  clearQoderSessionCaches();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/jobToken/exchange")) {
      return jsonResponse({
        token: "jt-1",
        refresh_token: "jrt-1",
        expires_in: 86_400_000,
      });
    }
    if (String(url).endsWith("/userinfo")) {
      return jsonResponse({ id: "user-1", email: "u@example.com", name: "User" });
    }
    if (String(url).endsWith("/algo/api/v2/model/list")) {
      return jsonResponse(CATALOG);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const models = await fetchQoderModelCatalog(
      "pt-test",
      qoderCnEndpoints(),
      "machine-1",
    );
    assert.equal(models.length, 2);
    assert.equal(calls.length, 3);

    const [exchange, userinfo, list] = calls;
    assert.equal(
      JSON.parse(exchange.init.body).personal_token,
      "pt-test",
    );
    assert.equal(
      userinfo.init.headers.Authorization,
      "Bearer jt-1",
    );
    assert.equal(list.init.method, "GET");
    assert.equal(list.init.headers["Cosy-User"], "user-1");
    assert.equal(list.init.headers["Cosy-Machineid"], "machine-1");
    assert.match(list.init.headers.Authorization, /^Bearer COSY\./);
  } finally {
    globalThis.fetch = originalFetch;
    clearQoderSessionCaches();
  }
});

test("retries once with a fresh job token after an auth rejection", async () => {
  clearQoderSessionCaches();
  const originalFetch = globalThis.fetch;
  let exchanges = 0;
  let lists = 0;
  globalThis.fetch = async (url) => {
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
    if (String(url).endsWith("/algo/api/v2/model/list")) {
      lists++;
      if (lists === 1) {
        return jsonResponse({ code: "105", message: "Login expired" }, 403);
      }
      return jsonResponse(CATALOG);
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const models = await fetchQoderModelCatalog(
      "pt-test",
      qoderCnEndpoints(),
      "machine-1",
    );
    assert.equal(models.length, 2);
    assert.equal(exchanges, 2);
    assert.equal(lists, 2);
  } finally {
    globalThis.fetch = originalFetch;
    clearQoderSessionCaches();
  }
});
