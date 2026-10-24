/**
 * Qoder CN wire identity: endpoint derivation (public / enterprise VPC), COSY
 * signature headers, and machine-id persistence.
 *
 * The signature scheme is the server's contract: the AES key that encrypts the
 * user-info envelope is carried base64-RSA-wrapped as `Cosy-Key`, and the
 * `Authorization` bearer is
 * `COSY.<base64(payload)>.<md5(payloadB64\ncosyKey\ntimestamp\nbody\nsigPath)>`.
 * The WAF-encoded body (see `qoder-encoding.ts`) is what the signature covers.
 *
 * Ported from `dsh-provider-qoder`.
 */
/** Credential/identity facts used to build one COSY signed request. */
export interface CosyCredentials {
    /** Server user id resolved from /userinfo; empty is not signable. */
    userID: string;
    /** Short-lived job token (jt-...) exchanged from the PAT. */
    authToken: string;
    name: string;
    email: string;
    machineID?: string;
}
/**
 * True when the value looks like a Qoder PAT (`pt-...`), not a job token.
 */
export declare function isQoderPatValue(value?: string): boolean;
/**
 * Resolve a Qoder CN PAT from the environment. `QODER_API_KEY` is accepted only
 * when its value is a PAT (`pt-...`), never an opaque key.
 */
export declare function getQoderCNPat(): string;
/**
 * Parse a tenant instance name from a VPC endpoint or bare instance value.
 * Accepts `<instance>.vpc.qoder.com.cn`,
 * `<instance>-gateway.vpc.qoder.com.cn`, `<instance>-openapi.vpc.qoder.com.cn`,
 * or a bare instance name.
 */
export declare function parseQoderVPCInstance(value?: string): string | undefined;
/** One CN wire-endpoint set. */
export interface QoderCnEndpoints {
    /** Gateway origin (no trailing slash) hosting the algo service. */
    gateway: string;
    /** OpenAPI origin hosting token exchange, refresh, and userinfo. */
    openapi: string;
    /** Tenant dashboard origin, when VPC-routed. */
    manage: string;
}
/**
 * Resolve the CN endpoints from an optional VPC instance.
 */
export declare function qoderCnEndpoints(vpcInstance?: string): QoderCnEndpoints;
/**
 * Resolve the endpoint set from environment overrides and an optional provider
 * `baseURL`. Explicit gateway/openapi variables win; otherwise a VPC host is
 * recognised and the public cloud is the fallback.
 */
export declare function resolveQoderEndpoints(baseURL?: string): QoderCnEndpoints;
/** PAT -> job-token exchange endpoint. */
export declare function qoderExchangeUrl(endpoints: QoderCnEndpoints): string;
/** Job-token refresh endpoint. */
export declare function qoderJobTokenRefreshUrl(endpoints: QoderCnEndpoints): string;
/** Identity lookup endpoint. */
export declare function qoderUserInfoUrl(endpoints: QoderCnEndpoints): string;
/** Streaming chat endpoint (WAF-encoded bodies, `FetchKeys=llm_model_result`). */
export declare function qoderChatUrl(endpoints: QoderCnEndpoints): string;
/** Model-catalog endpoint used by discovery. */
export declare function qoderModelListUrl(endpoints: QoderCnEndpoints): string;
/** The path portion the gateway signs, with the `/algo` prefix stripped. */
export declare function computeQoderSigPath(urlStr: string): string;
/**
 * OpenCode's data directory, used for the generated machine id.
 */
export declare function opencodeDataDir(): string;
/**
 * Persistable machine-id read in the qodercli / pi plugin order so an existing
 * install is recognised, generated once and stored under OpenCode's data dir
 * otherwise.
 */
export declare function getMachineId(dataDir?: string): string;
/**
 * Build the COSY signature headers for one request. The request body covered
 * by the signature is the WAF-encoded bytes sent on the wire.
 */
export declare function buildQoderAuthHeaders(body: Uint8Array | Buffer | string | null, requestURL: string, creds: CosyCredentials): Record<string, string>;
