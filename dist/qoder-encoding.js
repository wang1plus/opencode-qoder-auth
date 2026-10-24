/**
 * Qoder WAF-bypass body encoder.
 *
 * Standard base64 is rearranged in thirds and its alphabet permuted before the
 * bytes reach the gateway (`Encode=1`). The two alphabets are wire facts of the
 * qodercli client and must not be "improved".
 *
 * Ported from `dsh-provider-qoder` / `pi-provider-qoder`.
 */
const QODER_CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/**
 * Encode a JSON request body for the WAF-protected chat endpoint.
 * @param plaintext UTF-8 request body.
 * @returns the encoded string sent as the request body.
 */
export function qoderEncodeBody(plaintext) {
    const bytes = typeof plaintext === "string" ? Buffer.from(plaintext) : Buffer.from(plaintext);
    const std = bytes.toString("base64");
    const n = std.length;
    const a = Math.floor(n / 3);
    const rearranged = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
    let out = "";
    for (let i = 0; i < n; i++) {
        const c = rearranged[i];
        if (c === "=") {
            out += "$";
        }
        else {
            const idx = QODER_STD_ALPHABET.indexOf(c);
            out += idx >= 0 ? QODER_CUSTOM_ALPHABET[idx] : c;
        }
    }
    return out;
}
/**
 * Inverse of {@link qoderEncodeBody}, exposed for diagnostics and tests.
 * @param encoded the WAF-encoded body.
 * @returns the decoded UTF-8 string.
 */
export function qoderDecodeBody(encoded) {
    const rearranged = [...encoded]
        .map((c) => (c === "$" ? "=" : QODER_STD_ALPHABET[QODER_CUSTOM_ALPHABET.indexOf(c)] ?? c))
        .join("");
    const n = rearranged.length;
    const a = Math.floor(n / 3);
    const std = rearranged.slice(n - a) + rearranged.slice(a, n - a) + rearranged.slice(0, a);
    return Buffer.from(std, "base64").toString("utf8");
}
