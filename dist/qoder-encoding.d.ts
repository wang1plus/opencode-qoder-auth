/**
 * Qoder WAF-bypass body encoder.
 *
 * Standard base64 is rearranged in thirds and its alphabet permuted before the
 * bytes reach the gateway (`Encode=1`). The two alphabets are wire facts of the
 * qodercli client and must not be "improved".
 *
 * Ported from `dsh-provider-qoder` / `pi-provider-qoder`.
 */
/**
 * Encode a JSON request body for the WAF-protected chat endpoint.
 * @param plaintext UTF-8 request body.
 * @returns the encoded string sent as the request body.
 */
export declare function qoderEncodeBody(plaintext: string | Uint8Array): string;
/**
 * Inverse of {@link qoderEncodeBody}, exposed for diagnostics and tests.
 * @param encoded the WAF-encoded body.
 * @returns the decoded UTF-8 string.
 */
export declare function qoderDecodeBody(encoded: string): string;
