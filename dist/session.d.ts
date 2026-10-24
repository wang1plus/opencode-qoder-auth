/**
 * Process-local Qoder job-token and identity caches.
 *
 * One PAT is exchanged once per endpoint set, then rotated conservatively
 * because the advertised 24h job-token TTL has proven optimistic. When the
 * gateway rejects a cached token (HTTP 401/403 or an in-band `code 105`
 * envelope), callers invalidate the session and exchange once more.
 */
import type { QoderCnEndpoints } from "./cosy.js";
import { type QoderUserInfo } from "./pat.js";
/** Cache key shared by the job-token and identity caches. */
export declare function qoderSessionCacheKey(endpoints: QoderCnEndpoints, rawPat: string): string;
/** Drop the cached job-token session (auth-expired or poisoned). */
export declare function invalidateJobToken(endpoints: QoderCnEndpoints, rawPat: string): void;
/** Drop every cached session; intended for tests and process resets. */
export declare function clearQoderSessionCaches(): void;
/**
 * Exchange or refresh the job token for one PAT + endpoint set, caching per
 * process. `force` bypasses the cache and performs a fresh PAT exchange (used
 * after an auth-expiry response).
 */
export declare function ensureJobToken(rawPat: string, endpoints: QoderCnEndpoints, options?: {
    signal?: AbortSignal;
    force?: boolean;
}): Promise<string>;
/**
 * Resolve the server identity for one PAT, caching per process. A missing
 * userID means the PAT, job token, or VPC routing is wrong; callers treat it
 * as an auth failure.
 */
export declare function ensureIdentity(rawPat: string, jobToken: string, endpoints: QoderCnEndpoints, options?: {
    signal?: AbortSignal;
    force?: boolean;
}): Promise<QoderUserInfo>;
