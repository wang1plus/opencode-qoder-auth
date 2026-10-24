/**
 * Qoder CN token exchange and identity resolution.
 *
 * A Qoder PAT (`pt-...`) cannot authenticate API calls directly; it is
 * exchanged for a short-lived job token (`jt-...`) plus a job refresh token
 * (`jrt-...`), and the user identity is resolved from `/userinfo` because every
 * COSY-signed request needs the server userID.
 *
 * Ported from `dsh-provider-qoder`.
 */
import type { QoderCnEndpoints } from "./cosy.js";
/** A usable job-token session for one PAT. */
export interface QoderJobTokenSession {
    /** Short-lived job token (jt-...) used for auth + COSY signatures. */
    jobToken: string;
    /** Job refresh token (jrt-...), if the exchange returned one. */
    jobRefreshToken: string;
    /** Epoch ms when the job token expires (as advertised by the server). */
    expiresAt: number;
    /** Epoch ms when the job token was issued; drives conservative rotation. */
    issuedAt: number;
}
/** Identity fields resolved from `/userinfo`. */
export interface QoderUserInfo {
    userID: string;
    email: string;
    name: string;
}
/**
 * Exchange a Qoder PAT for a short-lived job token.
 * `POST {openapi}/api/v1/jobToken/exchange { personal_token }`.
 */
export declare function exchangeJobToken(pat: string, endpoints: QoderCnEndpoints, signal?: AbortSignal): Promise<QoderJobTokenSession>;
/**
 * Refresh a short-lived job token using the server-issued job refresh token.
 * `POST {openapi}/api/v1/jobToken/refresh { refresh_token }`.
 */
export declare function refreshJobToken(jobRefreshToken: string, endpoints: QoderCnEndpoints, signal?: AbortSignal): Promise<QoderJobTokenSession>;
/**
 * Fetch the user profile with a job token. Empty fields mean the request
 * failed or returned nothing; callers decide whether empty identity is fatal.
 */
export declare function fetchUserInfo(jobToken: string, endpoints: QoderCnEndpoints, signal?: AbortSignal): Promise<QoderUserInfo>;
