import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../dist/index.js";
import { clearQoderSessionCaches } from "../dist/session.js";

const CATALOG = {
  chat: [
    {
      key: "qwen3-coder-plus",
      display_name: "Qwen3 Coder Plus",
      enable: true,
      is_reasoning: true,
      max_output_tokens: 65536,
      context_config: { default: { token_count: 200000, is_default: true } },
    },
    {
      key: "vision-model",
      display_name: "Vision Model",
      enable: true,
      is_vl: true,
      context_config: { default: { token_count: 128000, is_default: true } },
    },
  ],
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createEventStream() {
  const queue = [];
  let wake;
  let aborted = false;
  return {
    push(event) {
      queue.push(event);
      wake?.();
    },
    abort() {
      aborted = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (!aborted) {
        if (queue.length > 0) {
          yield queue.shift();
          continue;
        }
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function createContext({
  pat = "pt-test",
  providerBaseURL,
  declaredModels = [],
} = {}) {
  const state = {
    providers: new Map(),
    integrations: new Map(),
    methods: new Map(),
    hooks: new Map(),
    reloads: 0,
  };
  if (providerBaseURL) {
    state.providers.set("qoder", {
      provider: {
        id: "qoder",
        name: "Qoder",
        settings: { baseURL: providerBaseURL },
      },
      models: new Map(declaredModels.map((model) => [model.id, model])),
    });
  }
  const events = createEventStream();

  const providerEditor = {
    list: () => [...state.providers.values()],
    get: (id) => state.providers.get(id),
    add({ info, models }) {
      state.providers.set(info.id, {
        provider: info,
        models: new Map(models.map((model) => [model.id, model])),
      });
    },
    update(id, update) {
      const record = state.providers.get(id);
      if (record) update(record.provider);
    },
    remove(id) {
      state.providers.delete(id);
    },
    models: {
      set(id, models) {
        const record = state.providers.get(id);
        if (record) {
          record.models = new Map(models.map((model) => [model.id, model]));
        }
      },
    },
  };

  const integrationEditor = {
    list: () => [...state.integrations.values()],
    get: (id) => state.integrations.get(id),
    update(id, update) {
      const integration = state.integrations.get(id) ?? { id, name: id };
      update(integration);
      state.integrations.set(id, integration);
    },
    remove(id) {
      state.integrations.delete(id);
    },
    method: {
      list: (integrationID) => state.methods.get(integrationID) ?? [],
      update({ integrationID, method }) {
        const list = state.methods.get(integrationID) ?? [];
        list.push(method);
        state.methods.set(integrationID, list);
      },
      remove() {},
    },
  };

  const context = {
    location: { directory: "/tmp/qoder-test" },
    provider: {
      transform: async (fn) => fn(providerEditor),
      reload: async () => {
        state.reloads++;
      },
    },
    integration: {
      transform: async (fn) => fn(integrationEditor),
      connection: {
        active: async () =>
          pat ? { id: "connection-1" } : undefined,
        resolve: async () =>
          pat ? { type: "key", key: pat } : undefined,
      },
    },
    session: {
      hook: async (name, fn, options) => {
        state.hooks.set(name, { fn, options });
      },
    },
    event: {
      subscribe: ({ signal }) => {
        signal.addEventListener("abort", () => events.abort());
        return events;
      },
    },
  };

  return { context, state, events };
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

function modelListFetch({ onChat } = {}) {
  const calls = { exchanges: 0, userinfo: 0, lists: 0, chats: 0 };
  const fetch = async (url) => {
    const target = typeof url === "string" ? url : url.url;
    if (target.endsWith("/jobToken/exchange")) {
      calls.exchanges++;
      return jsonResponse({
        token: `jt-${calls.exchanges}`,
        refresh_token: `jrt-${calls.exchanges}`,
        expires_in: 86_400_000,
      });
    }
    if (target.endsWith("/userinfo")) {
      calls.userinfo++;
      return jsonResponse({ id: "user-1", email: "u@example.com", name: "User" });
    }
    if (target.endsWith("/algo/api/v2/model/list")) {
      calls.lists++;
      return jsonResponse(CATALOG);
    }
    if (target.includes("/agent_chat_generation")) {
      calls.chats++;
      if (onChat) return onChat(calls.chats);
      return new Response(
        `data: ${JSON.stringify({
          statusCodeValue: 200,
          body: JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  return { fetch, calls };
}

test("registers the provider, integration methods, and hooks", async () => {
  const { fetch } = modelListFetch();
  await withFetch(fetch, async () => {
    const { context, state } = createContext();
    const cleanup = await plugin.setup(context);

    const record = state.providers.get("qoder");
    assert.ok(record, "provider must be registered");
    assert.equal(record.provider.name, "Qoder");
    assert.equal(record.provider.activation, "auto");
    assert.equal(
      record.provider.package,
      "@opencode/ai/providers/openai-compatible",
    );
    assert.equal(record.provider.integrationID, "qoder");
    assert.equal(record.provider.compatibility.maxTokensField, "max_tokens");
    assert.equal(
      record.provider.settings.baseURL,
      "https://gateway.qoder.com.cn",
    );
    assert.deepEqual([...record.models.keys()], [
      "qwen3-coder-plus",
      "vision-model",
    ]);

    const integration = state.integrations.get("qoder");
    assert.equal(integration.name, "Qoder");
    const methods = state.methods.get("qoder");
    assert.equal(methods.length, 2);
    assert.equal(methods[0].type, "key");
    assert.equal(methods[1].type, "env");
    assert.deepEqual(methods[1].names, [
      "QODERCN_PERSONAL_ACCESS_TOKEN",
      "QODERCN_PAT",
      "QODER_API_KEY",
    ]);

    assert.ok(state.hooks.has("http.request"));
    assert.ok(state.hooks.has("http.response"));
    assert.equal(state.hooks.get("http.request").options.providerID, "qoder");

    await cleanup();
  });
});

test("discovers models through a user-declared VPC baseURL", async () => {
  const urls = [];
  const fetch = async (url) => {
    const target = typeof url === "string" ? url : url.url;
    urls.push(target);
    if (target.endsWith("/jobToken/exchange")) {
      return jsonResponse({
        token: "jt-1",
        refresh_token: "jrt-1",
        expires_in: 86_400_000,
      });
    }
    if (target.endsWith("/userinfo")) {
      return jsonResponse({ id: "user-1", email: "u@example.com", name: "User" });
    }
    if (target.endsWith("/algo/api/v2/model/list")) return jsonResponse(CATALOG);
    throw new Error(`unexpected fetch ${target}`);
  };

  await withFetch(fetch, async () => {
    const { context, state } = createContext({
      providerBaseURL: "https://acme-gateway.vpc.qoder.com.cn",
    });
    const cleanup = await plugin.setup(context);

    assert.ok(
      urls.includes(
        "https://acme-gateway.vpc.qoder.com.cn/algo/api/v2/model/list",
      ),
    );
    assert.ok(
      urls.includes(
        "https://acme-openapi.vpc.qoder.com.cn/api/v1/jobToken/exchange",
      ),
    );
    const record = state.providers.get("qoder");
    assert.equal(
      record.provider.settings.baseURL,
      "https://acme-gateway.vpc.qoder.com.cn",
    );
    assert.equal(record.models.size, 2);

    await cleanup();
  });
});

test("preserves user-declared models that share a discovered ID", async () => {
  const { fetch } = modelListFetch();
  await withFetch(fetch, async () => {
    const declared = [
      {
        id: "qwen3-coder-plus",
        name: "My Qwen",
        limit: { context: 1024, output: 128 },
      },
      {
        id: "custom-model",
        name: "Custom",
        limit: { context: 2048, output: 256 },
      },
    ];
    const { context, state } = createContext({
      providerBaseURL: "https://gateway.qoder.com.cn",
      declaredModels: declared,
    });
    const cleanup = await plugin.setup(context);

    const record = state.providers.get("qoder");
    assert.equal(record.models.get("qwen3-coder-plus").name, "My Qwen");
    assert.deepEqual(record.models.get("qwen3-coder-plus").limit, {
      context: 1024,
      output: 128,
    });
    assert.ok(record.models.has("custom-model"));
    assert.ok(record.models.has("vision-model"));
    assert.equal(record.models.size, 3);

    await cleanup();
  });
});

test("rewrites an OpenAI request and retries an auth-expired response", async () => {
  const { fetch, calls } = modelListFetch();
  await withFetch(fetch, async () => {
    const { context, state } = createContext({
      providerBaseURL: "https://gateway.qoder.com.cn",
    });
    const cleanup = await plugin.setup(context);

    const requestHook = state.hooks.get("http.request").fn;
    const requestEvent = {
      sessionID: "session-1",
      agent: "build",
      model: { id: "qwen3-coder-plus", providerID: "qoder" },
      kind: "primary",
      request: new Request("https://gateway.qoder.com.cn/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer pt-test",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "qwen3-coder-plus",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "hello" },
          ],
          max_tokens: 1024,
          stream: true,
        }),
      }),
    };

    await requestHook(requestEvent);
    assert.match(requestEvent.request.url, /agent_chat_generation/);
    assert.match(
      requestEvent.request.headers.get("authorization"),
      /^Bearer COSY\./,
    );
    assert.ok(requestEvent.request.headers.get("x-qoder-request-id"));

    const responseHook = state.hooks.get("http.response").fn;
    const responseEvent = {
      sessionID: "session-1",
      agent: "build",
      model: { id: "qwen3-coder-plus", providerID: "qoder" },
      kind: "primary",
      request: requestEvent.request,
      response: new Response("", { status: 401 }),
    };

    await responseHook(responseEvent);
    assert.equal(responseEvent.response.status, 200);
    assert.match(
      responseEvent.response.headers.get("content-type"),
      /text\/event-stream/,
    );
    const text = await responseEvent.response.text();
    assert.match(text, /"content":"ok"/);
    assert.match(text, /data: \[DONE\]/);

    // Setup discovery + one forced re-exchange during the response retry.
    assert.equal(calls.exchanges, 2);
    assert.equal(calls.chats, 1);

    await cleanup();
  });
});

test("re-discovers models after a credential switch event", async () => {
  const { fetch, calls } = modelListFetch();
  await withFetch(fetch, async () => {
    const { context, state, events } = createContext({
      providerBaseURL: "https://gateway.qoder.com.cn",
    });
    const cleanup = await plugin.setup(context);

    assert.equal(calls.lists, 1);
    assert.equal(state.reloads, 0);

    events.push({
      type: "credential.switched",
      location: { directory: "/tmp/qoder-test" },
      data: { integrationID: "qoder", credentialID: "credential-1" },
    });

    for (let attempt = 0; attempt < 100 && state.reloads === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state.reloads, 1);
    assert.equal(calls.lists, 2);

    await cleanup();
  });
});

test("ignores credential events for another location or integration", async () => {
  const { fetch, calls } = modelListFetch();
  await withFetch(fetch, async () => {
    const { context, state, events } = createContext({
      providerBaseURL: "https://gateway.qoder.com.cn",
    });
    const cleanup = await plugin.setup(context);

    events.push({
      type: "credential.switched",
      location: { directory: "/tmp/other" },
      data: { integrationID: "qoder", credentialID: "credential-1" },
    });
    events.push({
      type: "credential.switched",
      location: { directory: "/tmp/qoder-test" },
      data: { integrationID: "other", credentialID: "credential-2" },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(state.reloads, 0);
    assert.equal(calls.lists, 1);

    await cleanup();
  });
});
