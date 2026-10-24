/**
 * Qoder CN credit balance.
 *
 * `GET {openapi}/api/v2/quota/usage` reports the account's credit pools:
 * `userQuota` (plan allowance), `addOnQuota` (gift / daily-check-in credits)
 * and, for team accounts, an organisation pool such as `orgResourcePackage`.
 * Unlike the gateway endpoints this one takes a plain `Bearer <job token>` —
 * no COSY signature — so it reuses the PAT exchange without any request
 * rewriting. The plan name from `/api/v2/user/plan` only labels the spot.
 */

import {
  qoderPlanUrl,
  qoderQuotaUrl,
  type QoderCnEndpoints,
} from "./cosy.js";
import {
  QoderError,
  isAuthExpiredDetail,
  isAuthExpiredStatus,
} from "./errors.js";
import { ensureJobToken, invalidateJobToken } from "./session.js";

/**
 * One account's balance, flattened for display. `ok` is false when the query
 * failed; every other field is then zeroed and `error` explains why.
 */
export interface QoderBalance {
  ok: boolean;
  /** Credits left across every counted pool (plan + add-on + shared). */
  remaining: number;
  /** Credits already consumed in those pools. */
  used: number;
  /** Pool capacity; `remaining + used` unless the upstream rounds. */
  total: number;
  /** Consumed share of the pools, 0-100. */
  usedPercent: number;
  /** Upstream says the account is out of credits. */
  exceeded: boolean;
  /** Whether an organisation / team pool contributed to the numbers. */
  shared: boolean;
  /** Plan tier name (`Free`, `Pro`, ...) when the upstream reports one. */
  plan: string | null;
  error?: string;
}

/** A failed balance query, ready to be returned to the TUI as-is. */
export function unavailableBalance(error: string): QoderBalance {
  return {
    ok: false,
    remaining: 0,
    used: 0,
    total: 0,
    usedPercent: 0,
    exceeded: false,
    shared: false,
    plan: null,
    error,
  };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Shared-pool keys seen on team / enterprise accounts, in priority order. */
const SHARED_POOL_KEYS = [
  "orgResourcePackage",
  "sharedQuota",
  "teamQuota",
  "poolQuota",
  "sharedCredits",
  "sharedCredit",
] as const;

interface SharedPool {
  remaining: number;
  used: number;
  total: number;
  available: boolean;
  /** `cap: -1` means "no upper bound"; its remaining field is a placeholder. */
  unlimited: boolean;
}

function sharedPoolOf(root: Record<string, unknown>): SharedPool | undefined {
  for (const key of SHARED_POOL_KEYS) {
    const source = recordOf(root[key]);
    if (!source) continue;
    const cap = number(source.cap) || number(source.total);
    return {
      remaining: number(source.remaining),
      used: number(source.used),
      total: cap,
      // A missing `available` key means "not declared unavailable".
      available: source.available === undefined ? true : Boolean(source.available),
      unlimited: cap < 0,
    };
  }
  return undefined;
}

/**
 * Flatten a `/quota/usage` response.
 *
 * A response where both quota objects are missing, or where the account is
 * flagged exceeded while reporting no capacity at all, is a degenerate body
 * seen from the upstream. Reporting it as an error is more honest than
 * rendering "0 credits".
 */
export function parseQoderQuota(value: unknown): QoderBalance {
  const root = recordOf(value);
  if (!root) {
    throw new QoderError("Qoder 额度接口返回的不是 JSON 对象", {
      code: "QUOTA_FAILED",
    });
  }

  const user = recordOf(root.userQuota);
  const addOn = recordOf(root.addOnQuota);
  if (!user && !addOn) {
    throw new QoderError("Qoder 额度接口没有返回任何额度池", {
      code: "QUOTA_FAILED",
    });
  }

  const remaining = number(user?.remaining) + number(addOn?.remaining);
  const used = number(user?.used) + number(addOn?.used);
  const total = number(user?.total) + number(addOn?.total);
  const exceeded = root.isQuotaExceeded === true;
  if (exceeded && remaining === 0 && total === 0) {
    throw new QoderError("Qoder 额度接口返回了空的额度数据", {
      code: "QUOTA_FAILED",
    });
  }

  const shared = sharedPoolOf(root);
  // An unlimited pool reports a placeholder `remaining`, so it is displayed
  // (as a flag) but never added to the balance.
  const counted = shared !== undefined && shared.available && !shared.unlimited;
  const totalRemaining = remaining + (counted ? shared.remaining : 0);
  const totalUsed = used + (counted ? shared.used : 0);
  const capacity = total + (counted ? shared.total : 0);
  const percent =
    capacity > 0
      ? (totalUsed / capacity) * 100
      : number(root.totalUsagePercentage) * 100;

  return {
    ok: true,
    remaining: Math.max(totalRemaining, 0),
    used: Math.max(totalUsed, 0),
    total: Math.max(capacity, 0),
    usedPercent: Math.min(Math.max(percent, 0), 100),
    exceeded,
    shared: shared !== undefined,
    plan: null,
  };
}

/** Plan tier name; a failure here must never fail the balance itself. */
async function fetchPlanName(
  jobToken: string,
  endpoints: QoderCnEndpoints,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await fetch(qoderPlanUrl(endpoints), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": "opencode-qoder-auth",
      },
      signal,
    });
    if (!response.ok) return null;
    const data = recordOf(await response.json());
    const name = data?.plan_tier_name ?? data?.user_type;
    return typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : null;
  } catch {
    return null;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Resolve the current balance for one PAT. The job token comes from the shared
 * process cache, so a balance refresh reuses the chat session's token; a
 * rejected token is exchanged once more before giving up.
 */
export async function fetchQoderBalance(
  rawPat: string,
  endpoints: QoderCnEndpoints,
  options: { signal?: AbortSignal } = {},
): Promise<QoderBalance> {
  const url = qoderQuotaUrl(endpoints);

  for (let attempt = 0; ; attempt++) {
    let jobToken: string;
    try {
      jobToken = await ensureJobToken(rawPat, endpoints, {
        signal: options.signal,
      });
    } catch (error: unknown) {
      return unavailableBalance(`无法获取 Qoder 令牌：${messageOf(error)}`);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jobToken}`,
          Accept: "application/json",
          "User-Agent": "opencode-qoder-auth",
        },
        signal: options.signal,
      });
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
      return unavailableBalance(`无法连接 Qoder 额度接口：${messageOf(error)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      if (
        attempt === 0 &&
        (isAuthExpiredStatus(response.status) || isAuthExpiredDetail(detail))
      ) {
        invalidateJobToken(endpoints, rawPat);
        continue;
      }
      const suffix = detail.length > 0 ? `：${detail.slice(0, 160)}` : "";
      return unavailableBalance(`Qoder 额度接口 HTTP ${response.status}${suffix}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
      return unavailableBalance("Qoder 额度接口返回了非 JSON 响应");
    }

    let balance: QoderBalance;
    try {
      balance = parseQoderQuota(payload);
    } catch (error: unknown) {
      return unavailableBalance(messageOf(error));
    }

    balance.plan = await fetchPlanName(jobToken, endpoints, options.signal);
    return balance;
  }
}
