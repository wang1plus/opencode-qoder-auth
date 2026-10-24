/**
 * Shared HTTP-status and in-band error classification for Qoder CN failures.
 */
/** Error carrying the Qoder/gateway status needed for auth retry decisions. */
export class QoderError extends Error {
    code;
    status;
    constructor(message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "QoderError";
        this.code = options.code;
        this.status = options.status;
    }
    get authExpired() {
        return isAuthExpiredStatus(this.status) || this.code === "105";
    }
}
/**
 * Whether an HTTP status marks the credential or job-token session as
 * rejected by the gateway (401/403, including Qoder's in-band
 * `403 {"code":"105","message":"Login expired"}` envelopes).
 */
export function isAuthExpiredStatus(status) {
    return status === 401 || status === 403;
}
/**
 * Map an HTTP status to a stable error code.
 */
export function httpErrorCode(status, detail) {
    if (isAuthExpiredStatus(status))
        return "AUTH";
    if (status === 429)
        return "RATE_LIMIT";
    if (status === 400)
        return "INVALID_REQUEST";
    if (status >= 500)
        return "SERVER";
    return `HTTP_${status}`;
}
/** Whether an error is an auth-expiry error from any layer. */
export function isAuthExpiredError(error) {
    if (error instanceof QoderError)
        return error.authExpired;
    if (error instanceof Error) {
        return /\b(?:401|403)\b/.test(error.message) || /\bcode["']?\s*[:=]\s*["']?105\b/.test(error.message);
    }
    return false;
}
function recordOf(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/**
 * Unwrap the gateway's JSON-encoded provider error before adding its request ID.
 */
export function upstreamErrorDetail(detail) {
    try {
        const body = JSON.parse(detail);
        const nested = typeof body.details === "string"
            ? JSON.parse(body.details)
            : recordOf(body.details);
        const nestedError = recordOf(nested?.error);
        const bodyError = recordOf(body.error);
        const message = nestedError?.message ?? bodyError?.message ?? body.message;
        if (typeof message === "string" && message.length > 0) {
            const requestId = typeof body.request_id === "string"
                ? ` (request_id: ${body.request_id})`
                : "";
            return `${message.slice(0, 2000)}${requestId}`;
        }
    }
    catch {
        // Plain-text or malformed details must not hide the original provider failure.
    }
    return detail.slice(0, 2000);
}
/**
 * Extract the provider error code from a JSON error body, when present.
 */
export function errorCodeOf(detail) {
    try {
        const body = JSON.parse(detail);
        const code = body.code ?? recordOf(body.error)?.code;
        if (typeof code === "string" || typeof code === "number")
            return String(code);
    }
    catch {
        // Not JSON.
    }
    return undefined;
}
/**
 * Whether a plain JSON/text error body is an auth-expiry failure (Qoder's
 * in-band `code 105` login-expired envelope).
 */
export function isAuthExpiredDetail(detail) {
    return errorCodeOf(detail) === "105" || /"code"\s*:\s*"?105"?/.test(detail);
}
