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

const UA = "opencode-qoder-auth";

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

/** Exchange response shape (public CN OpenAPI). */
interface ExchangeResponse {
  token?: string;
  refresh_token?: string;
  created_at?: string;
  expires_at?: string;
  expires_in?: number;
  refresh_token_expires_at?: string;
  refresh_token_expires_in?: number;
}

function parseExpiry(data: ExchangeResponse): number {
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (data.expires_in) {
    // expires_in is in milliseconds per the observed API response.
    return Date.now() + data.expires_in;
  }
  return Date.now() + 24 * 60 * 60 * 1000;
}

/**
 * When the server issued the job token. The advertised 24h expiry proved
 * optimistic, so callers also rotate sessions on a conservative age window.
 */
function parseIssuedAt(data: ExchangeResponse): number {
  if (data.created_at) {
    const parsed = Date.parse(data.created_at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

const TOKEN_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": UA,
  "Cosy-Version": "1.0.1",
  "Cosy-ClientType": "5",
};

/**
 * Exchange a Qoder PAT for a short-lived job token.
 * `POST {openapi}/api/v1/jobToken/exchange { personal_token }`.
 */
export async function exchangeJobToken(
  pat: string,
  endpoints: QoderCnEndpoints,
  signal?: AbortSignal,
): Promise<QoderJobTokenSession> {
  const res = await fetch(`${endpoints.openapi}/api/v1/jobToken/exchange`, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: JSON.stringify({ personal_token: pat }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Qoder CN PAT exchange failed: ${res.status} ${res.statusText}. Response: ${text.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as ExchangeResponse;
  if (!data.token) {
    throw new Error("Qoder CN PAT exchange returned no job token");
  }

  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || "",
    expiresAt: parseExpiry(data),
    issuedAt: parseIssuedAt(data),
  };
}

/**
 * Refresh a short-lived job token using the server-issued job refresh token.
 * `POST {openapi}/api/v1/jobToken/refresh { refresh_token }`.
 */
export async function refreshJobToken(
  jobRefreshToken: string,
  endpoints: QoderCnEndpoints,
  signal?: AbortSignal,
): Promise<QoderJobTokenSession> {
  if (jobRefreshToken.trim().length === 0) {
    throw new Error(
      "Qoder CN job token refresh requires a non-empty refresh_token (jrt-...)",
    );
  }

  const res = await fetch(`${endpoints.openapi}/api/v1/jobToken/refresh`, {
    method: "POST",
    headers: TOKEN_HEADERS,
    body: JSON.stringify({ refresh_token: jobRefreshToken }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Qoder CN job token refresh failed: ${res.status} ${res.statusText}. Response: ${text.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as ExchangeResponse;
  if (!data.token) {
    throw new Error("Qoder CN job token refresh returned no job token");
  }

  return {
    jobToken: data.token,
    jobRefreshToken: data.refresh_token || jobRefreshToken,
    expiresAt: parseExpiry(data),
    issuedAt: parseIssuedAt(data),
  };
}

/**
 * Fetch the user profile with a job token. Empty fields mean the request
 * failed or returned nothing; callers decide whether empty identity is fatal.
 */
export async function fetchUserInfo(
  jobToken: string,
  endpoints: QoderCnEndpoints,
  signal?: AbortSignal,
): Promise<QoderUserInfo> {
  let userID = "";
  let email = "";
  let name = "";
  try {
    const res = await fetch(`${endpoints.openapi}/api/v1/userinfo`, {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": UA,
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5",
      },
      signal,
    });
    if (res.ok) {
      const info = (await res.json()) as {
        id?: string;
        email?: string;
        name?: string;
        username?: string;
      };
      userID = info.id || "";
      email = info.email || "";
      name = info.name || info.username || "";
    }
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    // Callers decide whether an unavailable identity is fatal.
  }
  return { userID, email, name };
}
