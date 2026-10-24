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
import { type QoderCnEndpoints } from "./cosy.js";
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
export declare function unavailableBalance(error: string): QoderBalance;
/**
 * Flatten a `/quota/usage` response.
 *
 * A response where both quota objects are missing, or where the account is
 * flagged exceeded while reporting no capacity at all, is a degenerate body
 * seen from the upstream. Reporting it as an error is more honest than
 * rendering "0 credits".
 */
export declare function parseQoderQuota(value: unknown): QoderBalance;
/**
 * Resolve the current balance for one PAT. The job token comes from the shared
 * process cache, so a balance refresh reuses the chat session's token; a
 * rejected token is exchanged once more before giving up.
 */
export declare function fetchQoderBalance(rawPat: string, endpoints: QoderCnEndpoints, options?: {
    signal?: AbortSignal;
}): Promise<QoderBalance>;
