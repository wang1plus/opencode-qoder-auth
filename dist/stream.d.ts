/**
 * Qoder double-enveloped SSE -> standard OpenAI Chat SSE.
 *
 * Qoder streams `data: {"statusCodeValue":200,"body":"<JSON string>"}` frames
 * whose inner body is an OpenAI-style chunk. OpenCode's OpenAI Chat protocol
 * expects ordinary `data: {choices:[...]}` frames and a final `[DONE]`, so this
 * module unwraps the envelope, extracts tagged reasoning, normalizes tool-call
 * deltas, and guards incomplete/empty generations.
 */
export declare const DONE = "[DONE]";
/** One decoded Qoder SSE payload. */
export interface QoderEnvelope {
    statusCodeValue: number;
    body: unknown;
}
/** Options for one OpenAI-compatible response stream. */
export interface QoderStreamOptions {
    model: string;
    id?: string;
    created?: number;
}
/**
 * Decode one SSE `data:` payload into the envelope.
 */
export declare function parseQoderEnvelope(data: string): QoderEnvelope;
/**
 * True when an SSE payload is an auth-expiry envelope (`401/403`, or an
 * in-band `code 105` login-expired body).
 */
export declare function isAuthExpiredPayload(payload: string): boolean;
/**
 * Read just enough of a Qoder SSE response to decide whether the first frame is
 * an auth-expiry error, then return a response that replays every byte.
 */
export declare function peekQoderSseAuth(response: Response): Promise<{
    response: Response;
    authExpired: boolean;
}>;
/**
 * Transform a Qoder SSE byte stream into standard OpenAI Chat SSE.
 */
export declare function transformQoderSse(body: ReadableStream<Uint8Array>, options: QoderStreamOptions): ReadableStream<Uint8Array>;
/**
 * Wrap a Qoder HTTP response as an OpenAI Chat SSE response.
 */
export declare function transformQoderResponse(response: Response, options: QoderStreamOptions): Response;
