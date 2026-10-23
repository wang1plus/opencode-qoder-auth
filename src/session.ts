/**
 * Process-local Qoder job-token and identity caches.
 *
 * One PAT is exchanged once per endpoint set, then rotated conservatively
 * because the advertised 24h job-token TTL has proven optimistic. When the
 * gateway rejects a cached token (HTTP 401/403 or an in-band `code 105`
 * envelope), callers invalidate the session and exchange once more.
 */

import crypto from "node:crypto";
import type { QoderCnEndpoints } from "./cosy.js";
import { QoderError, isAuthExpiredStatus } from "./errors.js";
import {
  exchangeJobToken,
  fetchUserInfo,
  refreshJobToken,
  type QoderJobTokenSession,
  type QoderUserInfo,
} from "./pat.js";

/**
 * Conservative rotation window: the server advertises a 24h job-token TTL but
 * the gateway has been observed rejecting tokens after roughly two hours, so
 * sessions rotate by age well before the advertised expiry.
 */
const JOB_TOKEN_MAX_AGE_MS = 30 * 60 * 1000;
/** Safety margin ahead of the advertised expiry before proactive rotation. */
const JOB_TOKEN_EXPIRY_SLACK_MS = 5 * 60 * 1000;

const jobTokenCache = new Map<string, QoderJobTokenSession>();
const identityCache = new Map<string, QoderUserInfo>();

function hashCredential(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Cache key shared by the job-token and identity caches. */
export function qoderSessionCacheKey(
  endpoints: QoderCnEndpoints,
  rawPat: string,
): string {
  return `${endpoints.gateway}\0${endpoints.openapi}\0${hashCredential(rawPat)}`;
}

/** Drop the cached job-token session (auth-expired or poisoned). */
export function invalidateJobToken(
  endpoints: QoderCnEndpoints,
  rawPat: string,
): void {
  jobTokenCache.delete(qoderSessionCacheKey(endpoints, rawPat));
}

/** Drop every cached session; intended for tests and process resets. */
export function clearQoderSessionCaches(): void {
  jobTokenCache.clear();
  identityCache.clear();
}

/** Whether a cached session is still trusted: unexpired and not too old. */
function jobTokenUsable(session: QoderJobTokenSession): boolean {
  return (
    session.expiresAt > Date.now() + JOB_TOKEN_EXPIRY_SLACK_MS &&
    session.issuedAt + JOB_TOKEN_MAX_AGE_MS > Date.now()
  );
}

function authErrorFromExchange(error: unknown): unknown {
  if (error instanceof Error) {
    const match = /failed:\s*(\d{3})/.exec(error.message);
    if (match) {
      const status = Number(match[1]);
      return new QoderError(error.message, {
        code: isAuthExpiredStatus(status) ? "AUTH" : `HTTP_${status}`,
        status,
        cause: error,
      });
    }
  }
  return error;
}

/**
 * Exchange or refresh the job token for one PAT + endpoint set, caching per
 * process. `force` bypasses the cache and performs a fresh PAT exchange (used
 * after an auth-expiry response).
 */
export async function ensureJobToken(
  rawPat: string,
  endpoints: QoderCnEndpoints,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<string> {
  const key = qoderSessionCacheKey(endpoints, rawPat);
  const cached = jobTokenCache.get(key);

  if (!options.force && cached !== undefined && jobTokenUsable(cached)) {
    return cached.jobToken;
  }

  if (!options.force && cached !== undefined && cached.jobRefreshToken.length > 0) {
    try {
      const refreshed = await refreshJobToken(
        cached.jobRefreshToken,
        endpoints,
        options.signal,
      );
      jobTokenCache.set(key, refreshed);
      return refreshed.jobToken;
    } catch (error: unknown) {
      if (options.signal?.aborted) throw error;
      // Fall through to a fresh PAT exchange.
    }
  }

  try {
    const exchanged = await exchangeJobToken(rawPat, endpoints, options.signal);
    jobTokenCache.set(key, exchanged);
    return exchanged.jobToken;
  } catch (error: unknown) {
    throw authErrorFromExchange(error);
  }
}

/**
 * Resolve the server identity for one PAT, caching per process. A missing
 * userID means the PAT, job token, or VPC routing is wrong; callers treat it
 * as an auth failure.
 */
export async function ensureIdentity(
  rawPat: string,
  jobToken: string,
  endpoints: QoderCnEndpoints,
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<QoderUserInfo> {
  const key = qoderSessionCacheKey(endpoints, rawPat);
  const cached = identityCache.get(key);
  if (!options.force && cached?.userID) return cached;

  const info = await fetchUserInfo(jobToken, endpoints, options.signal);
  if (!info.userID) {
    throw new QoderError(
      "Qoder CN identity unavailable: /userinfo did not return a userID. Check the PAT and VPC routing (QODER_VPC_INSTANCE), then retry.",
      { code: "AUTH" },
    );
  }
  const resolved: QoderUserInfo = {
    userID: info.userID,
    email: info.email || "user@qoder.com.cn",
    name: info.name || "Qoder CN User",
  };
  identityCache.set(key, resolved);
  return resolved;
}
