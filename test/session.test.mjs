import assert from "node:assert/strict";
import test from "node:test";
import {
  clearQoderSessionCaches,
  ensureIdentity,
  ensureJobToken,
  invalidateJobToken,
} from "../dist/session.js";
import { qoderCnEndpoints } from "../dist/cosy.js";
import { QoderError } from "../dist/errors.js";

const endpoints = qoderCnEndpoints();

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

test("caches the PAT exchange across calls", async () => {
  let exchanges = 0;
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/jobToken/exchange")) {
        exchanges++;
        return jsonResponse({ token: "jt-1", refresh_token: "jrt-1", expires_in: 86_400_000 });
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      assert.equal(await ensureJobToken("pt-1", endpoints), "jt-1");
      assert.equal(await ensureJobToken("pt-1", endpoints), "jt-1");
      assert.equal(exchanges, 1);
    },
  );
});

test("force bypasses the cache with a fresh exchange", async () => {
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
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      assert.equal(await ensureJobToken("pt-1", endpoints), "jt-1");
      assert.equal(
        await ensureJobToken("pt-1", endpoints, { force: true }),
        "jt-2",
      );
      assert.equal(exchanges, 2);
    },
  );
});

test("refreshes an expired job token through the refresh token", async () => {
  let exchanges = 0;
  let refreshes = 0;
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/jobToken/exchange")) {
        exchanges++;
        return jsonResponse({
          token: "jt-short",
          refresh_token: "jrt-1",
          expires_in: 1000,
        });
      }
      if (String(url).endsWith("/jobToken/refresh")) {
        refreshes++;
        return jsonResponse({
          token: "jt-refreshed",
          refresh_token: "jrt-2",
          expires_in: 86_400_000,
        });
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      assert.equal(await ensureJobToken("pt-1", endpoints), "jt-short");
      assert.equal(await ensureJobToken("pt-1", endpoints), "jt-refreshed");
      assert.equal(exchanges, 1);
      assert.equal(refreshes, 1);
    },
  );
});

test("invalidation forces the next call to exchange again", async () => {
  let exchanges = 0;
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/jobToken/exchange")) {
        exchanges++;
        return jsonResponse({
          token: `jt-${exchanges}`,
          refresh_token: "",
          expires_in: 86_400_000,
        });
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      assert.equal(await ensureJobToken("pt-1", endpoints), "jt-1");
      invalidateJobToken(endpoints, "pt-1");
      assert.equal(await ensureJobToken("pt-1", endpoints), "jt-2");
      assert.equal(exchanges, 2);
    },
  );
});

test("maps an exchange 401 to an auth-expired QoderError", async () => {
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/jobToken/exchange")) {
        return jsonResponse({ message: "invalid PAT" }, 401);
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      await assert.rejects(
        () => ensureJobToken("pt-bad", endpoints),
        (error) => {
          assert.ok(error instanceof QoderError);
          assert.equal(error.status, 401);
          assert.equal(error.authExpired, true);
          return true;
        },
      );
    },
  );
});

test("caches identity and rejects an empty userID", async () => {
  let userinfo = 0;
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/userinfo")) {
        userinfo++;
        return jsonResponse({ id: "user-1", email: "u@example.com", name: "User" });
      }
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      const first = await ensureIdentity("pt-1", "jt-1", endpoints);
      const second = await ensureIdentity("pt-1", "jt-2", endpoints);
      assert.deepEqual(first, {
        userID: "user-1",
        email: "u@example.com",
        name: "User",
      });
      assert.deepEqual(second, first);
      assert.equal(userinfo, 1);
    },
  );

  await withFetch(
    async (url) => {
      if (String(url).endsWith("/userinfo")) return jsonResponse({});
      throw new Error(`unexpected ${url}`);
    },
    async () => {
      await assert.rejects(
        () => ensureIdentity("pt-2", "jt-1", endpoints),
        (error) => {
          assert.ok(error instanceof QoderError);
          assert.equal(error.code, "AUTH");
          return true;
        },
      );
    },
  );
});
