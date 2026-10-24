import assert from "node:assert/strict";
import test from "node:test";
import { qoderCnEndpoints } from "../dist/cosy.js";
import { fetchQoderBalance, parseQoderQuota } from "../dist/quota.js";
import { clearQoderSessionCaches } from "../dist/session.js";

/** Shape captured from a live CN account (Free plan, 200 add-on credits). */
const QUOTA = {
  userId: "user-1",
  userType: "personal_standard",
  usageType: "credits",
  totalUsagePercentage: 0.26,
  isQuotaExceeded: false,
  expiresAt: 253402214400000,
  userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: "credits" },
  addOnQuota: {
    total: 200,
    used: 51,
    remaining: 149,
    percentage: 0.26,
    unit: "credits",
  },
};

const PLAN = {
  user_type: "personal_standard",
  plan_tier_name: "Free",
  is_personal_version: true,
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Exchange + quota + plan mock; individual endpoints are overridable. */
function quotaFetch({ quota, plan, onQuota } = {}) {
  const calls = { exchanges: 0, quotas: 0, plans: 0 };
  const fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/jobToken/exchange")) {
      calls.exchanges++;
      return jsonResponse({
        token: `jt-${calls.exchanges}`,
        refresh_token: `jrt-${calls.exchanges}`,
        expires_in: 86_400_000,
      });
    }
    if (target.endsWith("/api/v2/quota/usage")) {
      calls.quotas++;
      if (onQuota) {
        const override = await onQuota(calls.quotas, init);
        if (override) return override;
      }
      return jsonResponse(quota ?? QUOTA);
    }
    if (target.endsWith("/api/v2/user/plan")) {
      calls.plans++;
      return plan === undefined ? jsonResponse(PLAN) : plan;
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  return { fetch, calls };
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

test("aggregates the plan and add-on credit pools", () => {
  const balance = parseQoderQuota(QUOTA);
  assert.equal(balance.ok, true);
  assert.equal(balance.remaining, 149);
  assert.equal(balance.used, 51);
  assert.equal(balance.total, 200);
  assert.equal(balance.usedPercent, 25.5);
  assert.equal(balance.exceeded, false);
  assert.equal(balance.shared, false);
  assert.equal(balance.plan, null);
});

test("counts an available team pool but never an unlimited one", () => {
  const shared = parseQoderQuota({
    isQuotaExceeded: false,
    userQuota: { total: 100, used: 100, remaining: 0 },
    addOnQuota: { total: 0, used: 0, remaining: 0 },
    orgResourcePackage: {
      used: 1548,
      remaining: 952,
      percentage: 0.62,
      unit: "credits",
      cap: 2500,
      available: true,
    },
  });
  assert.equal(shared.shared, true);
  assert.equal(shared.remaining, 952);
  assert.equal(shared.used, 1648);
  assert.equal(shared.total, 2600);

  const unavailable = parseQoderQuota({
    ...QUOTA,
    orgResourcePackage: { remaining: 952, cap: 2500, available: false },
  });
  assert.equal(unavailable.shared, true);
  assert.equal(unavailable.remaining, 149);

  // `cap: -1` is the "no upper bound" sentinel; its remaining is a placeholder.
  const unlimited = parseQoderQuota({
    ...QUOTA,
    orgResourcePackage: { remaining: 9999, used: 0, cap: -1 },
  });
  assert.equal(unlimited.shared, true);
  assert.equal(unlimited.remaining, 149);
  assert.equal(unlimited.total, 200);
});

test("rejects degenerate quota bodies instead of reporting zero", () => {
  assert.throws(() => parseQoderQuota({}), /没有返回任何额度池/);
  assert.throws(() => parseQoderQuota(null), /不是 JSON 对象/);
  assert.throws(
    () => parseQoderQuota({ isQuotaExceeded: true }),
    /没有返回任何额度池/,
  );
  assert.throws(
    () =>
      parseQoderQuota({
        isQuotaExceeded: true,
        userQuota: { total: 0, used: 0, remaining: 0 },
        addOnQuota: { total: 0, used: 0, remaining: 0 },
      }),
    /空的额度数据/,
  );

  // A genuinely exhausted account keeps its capacity and is still shown.
  const exhausted = parseQoderQuota({
    isQuotaExceeded: true,
    userQuota: { total: 0, used: 0, remaining: 0 },
    addOnQuota: { total: 200, used: 200, remaining: 0 },
  });
  assert.equal(exhausted.ok, true);
  assert.equal(exhausted.remaining, 0);
  assert.equal(exhausted.exceeded, true);
});

test("fetches the balance with a plain job-token bearer and labels the plan", async () => {
  const { fetch, calls } = quotaFetch();
  await withFetch(fetch, async () => {
    const balance = await fetchQoderBalance("pt-test", qoderCnEndpoints());
    assert.equal(balance.ok, true);
    assert.equal(balance.remaining, 149);
    assert.equal(balance.usedPercent, 25.5);
    assert.equal(balance.plan, "Free");
    assert.deepEqual(calls, { exchanges: 1, quotas: 1, plans: 1 });
  });
});

test("sends no COSY headers and reuses the cached job token", async () => {
  const requests = [];
  const { fetch } = quotaFetch({
    onQuota: async (_count, init) => {
      requests.push(init);
      return undefined;
    },
  });
  await withFetch(fetch, async () => {
    await fetchQoderBalance("pt-test", qoderCnEndpoints());
    await fetchQoderBalance("pt-test", qoderCnEndpoints());
    assert.equal(requests.length, 2);
    for (const init of requests) {
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, "Bearer jt-1");
      assert.equal(init.headers["Cosy-User"], undefined);
      assert.equal(init.headers["Cosy-Key"], undefined);
    }
  });
});

test("exchanges a fresh job token after an auth rejection", async () => {
  const { fetch, calls } = quotaFetch({
    onQuota: async (count) =>
      count === 1
        ? new Response(JSON.stringify({ code: "105", message: "Login expired" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
        : undefined,
  });
  await withFetch(fetch, async () => {
    const balance = await fetchQoderBalance("pt-test", qoderCnEndpoints());
    assert.equal(balance.ok, true);
    assert.equal(balance.remaining, 149);
    assert.equal(calls.exchanges, 2);
    assert.equal(calls.quotas, 2);
  });
});

test("reports failures without throwing", async () => {
  const http = quotaFetch({
    onQuota: async () => new Response("nope", { status: 500 }),
  });
  await withFetch(http.fetch, async () => {
    const balance = await fetchQoderBalance("pt-test", qoderCnEndpoints());
    assert.equal(balance.ok, false);
    assert.match(balance.error, /HTTP 500/);
    assert.equal(balance.remaining, 0);
  });

  const broken = quotaFetch({
    onQuota: async () =>
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  await withFetch(broken.fetch, async () => {
    const balance = await fetchQoderBalance("pt-test", qoderCnEndpoints());
    assert.equal(balance.ok, false);
    assert.match(balance.error, /非 JSON/);
  });

  await withFetch(
    async () => {
      throw new Error("network down");
    },
    async () => {
      const balance = await fetchQoderBalance("pt-test", qoderCnEndpoints());
      assert.equal(balance.ok, false);
      assert.match(balance.error, /无法获取 Qoder 令牌/);
    },
  );
});

test("a failing plan lookup does not fail the balance", async () => {
  const { fetch } = quotaFetch({
    plan: new Response("boom", { status: 503 }),
  });
  await withFetch(fetch, async () => {
    const balance = await fetchQoderBalance("pt-test", qoderCnEndpoints());
    assert.equal(balance.ok, true);
    assert.equal(balance.remaining, 149);
    assert.equal(balance.plan, null);
  });
});
