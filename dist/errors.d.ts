/**
 * Shared HTTP-status and in-band error classification for Qoder CN failures.
 */
/** Error carrying the Qoder/gateway status needed for auth retry decisions. */
export declare class QoderError extends Error {
    readonly code?: string;
    readonly status?: number;
    constructor(message: string, options?: {
        code?: string;
        status?: number;
        cause?: unknown;
    });
    get authExpired(): boolean;
}
/**
 * Whether an HTTP status marks the credential or job-token session as
 * rejected by the gateway (401/403, including Qoder's in-band
 * `403 {"code":"105","message":"Login expired"}` envelopes).
 */
export declare function isAuthExpiredStatus(status: number | undefined): boolean;
/**
 * Map an HTTP status to a stable error code.
 */
export declare function httpErrorCode(status: number, detail: string): string;
/** Whether an error is an auth-expiry error from any layer. */
export declare function isAuthExpiredError(error: unknown): boolean;
/**
 * Unwrap the gateway's JSON-encoded provider error before adding its request ID.
 */
export declare function upstreamErrorDetail(detail: string): string;
/**
 * Extract the provider error code from a JSON error body, when present.
 */
export declare function errorCodeOf(detail: string): string | undefined;
/**
 * Whether a plain JSON/text error body is an auth-expiry failure (Qoder's
 * in-band `code 105` login-expired envelope).
 */
export declare function isAuthExpiredDetail(detail: string): boolean;
