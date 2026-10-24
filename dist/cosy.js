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
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
/** Client identity the gateway recognises as the official qodercli desktop. */
const QODER_IDE_VERSION = "1.0.0";
const QODER_CLIENT_TYPE = "5";
const QODER_DATA_POLICY = "disagree";
const QODER_LOGIN_VERSION = "v2";
const QODER_MACHINE_OS = "x86_64_windows";
const QODER_MACHINE_TYPE_MAGIC = "5";
const QODER_VPC_DOMAIN = "vpc.qoder.com.cn";
const QODER_PUBLIC_GATEWAY = "https://gateway.qoder.com.cn";
const QODER_PUBLIC_OPENAPI = "https://openapi.qoder.com.cn";
const QODER_PUBLIC_MANAGE = "https://qoder.com.cn";
/**
 * True when the value looks like a Qoder PAT (`pt-...`), not a job token.
 */
export function isQoderPatValue(value) {
    return Boolean(value?.trim().startsWith("pt-"));
}
/**
 * Resolve a Qoder CN PAT from the environment. `QODER_API_KEY` is accepted only
 * when its value is a PAT (`pt-...`), never an opaque key.
 */
export function getQoderCNPat() {
    const dedicated = process.env.QODERCN_PERSONAL_ACCESS_TOKEN || process.env.QODERCN_PAT || "";
    if (dedicated.trim())
        return dedicated.trim();
    const apiKey = process.env.QODER_API_KEY || "";
    return isQoderPatValue(apiKey) ? apiKey.trim() : "";
}
/**
 * Parse a tenant instance name from a VPC endpoint or bare instance value.
 * Accepts `<instance>.vpc.qoder.com.cn`,
 * `<instance>-gateway.vpc.qoder.com.cn`, `<instance>-openapi.vpc.qoder.com.cn`,
 * or a bare instance name.
 */
export function parseQoderVPCInstance(value) {
    if (!value?.trim())
        return undefined;
    let candidate = value.trim().toLowerCase();
    try {
        candidate = new URL(candidate.includes("://") ? candidate : `https://${candidate}`).hostname;
    }
    catch {
        return undefined;
    }
    const suffix = `.${QODER_VPC_DOMAIN}`;
    if (candidate.endsWith(suffix)) {
        candidate = candidate.slice(0, -suffix.length);
        if (candidate.endsWith("-gateway") || candidate.endsWith("-openapi")) {
            candidate = candidate.slice(0, -8);
        }
    }
    else if (candidate.includes(".")) {
        return undefined;
    }
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(candidate)
        ? candidate
        : undefined;
}
/**
 * Resolve the CN endpoints from an optional VPC instance.
 */
export function qoderCnEndpoints(vpcInstance) {
    if (vpcInstance !== undefined && vpcInstance.length > 0) {
        return {
            gateway: `https://${vpcInstance}-gateway.${QODER_VPC_DOMAIN}`,
            openapi: `https://${vpcInstance}-openapi.${QODER_VPC_DOMAIN}`,
            manage: `https://${vpcInstance}.${QODER_VPC_DOMAIN}`,
        };
    }
    return {
        gateway: QODER_PUBLIC_GATEWAY,
        openapi: QODER_PUBLIC_OPENAPI,
        manage: QODER_PUBLIC_MANAGE,
    };
}
function trimTrailingSlash(value) {
    return value.replace(/\/+$/, "");
}
function firstEnvironment(...names) {
    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value)
            return value;
    }
    return undefined;
}
/**
 * Resolve the endpoint set from environment overrides and an optional provider
 * `baseURL`. Explicit gateway/openapi variables win; otherwise a VPC host is
 * recognised and the public cloud is the fallback.
 */
export function resolveQoderEndpoints(baseURL) {
    const explicitGateway = firstEnvironment("QODER_GATEWAY_URL", "QODER_GATEWAY");
    const explicitOpenapi = firstEnvironment("QODER_OPENAPI_URL", "QODER_OPENAPI");
    const explicitManage = firstEnvironment("QODER_MANAGE_URL", "QODER_MANAGE");
    if (explicitGateway && explicitOpenapi) {
        return {
            gateway: trimTrailingSlash(explicitGateway),
            openapi: trimTrailingSlash(explicitOpenapi),
            manage: trimTrailingSlash(explicitManage ?? QODER_PUBLIC_MANAGE),
        };
    }
    const vpcInstance = parseQoderVPCInstance(firstEnvironment("QODER_VPC_INSTANCE", "QODER_VPC_ENDPOINT", "QODERCN_VPC_ENDPOINT", "QODERCN_CLI_VPC_ENDPOINT", "QODER_CN_BASE_URL", "QODER_CN_OPENAPI_URL", "QODER_CN_CENTER_URL")) ?? parseQoderVPCInstance(baseURL);
    if (vpcInstance) {
        const endpoints = qoderCnEndpoints(vpcInstance);
        return {
            ...endpoints,
            ...(explicitOpenapi ? { openapi: trimTrailingSlash(explicitOpenapi) } : {}),
            ...(explicitManage ? { manage: trimTrailingSlash(explicitManage) } : {}),
        };
    }
    if (baseURL?.trim()) {
        try {
            const parsed = new URL(baseURL.trim());
            const host = parsed.hostname.toLowerCase();
            if (host === "gateway.qoder.com.cn" || host === "openapi.qoder.com.cn") {
                return qoderCnEndpoints();
            }
            return {
                gateway: `${parsed.protocol}//${parsed.host}`,
                openapi: explicitOpenapi
                    ? trimTrailingSlash(explicitOpenapi)
                    : QODER_PUBLIC_OPENAPI,
                manage: explicitManage
                    ? trimTrailingSlash(explicitManage)
                    : QODER_PUBLIC_MANAGE,
            };
        }
        catch {
            // Keep the public defaults for malformed overrides.
        }
    }
    return qoderCnEndpoints();
}
/** PAT -> job-token exchange endpoint. */
export function qoderExchangeUrl(endpoints) {
    return `${endpoints.openapi}/api/v1/jobToken/exchange`;
}
/** Job-token refresh endpoint. */
export function qoderJobTokenRefreshUrl(endpoints) {
    return `${endpoints.openapi}/api/v1/jobToken/refresh`;
}
/** Identity lookup endpoint. */
export function qoderUserInfoUrl(endpoints) {
    return `${endpoints.openapi}/api/v1/userinfo`;
}
/** Streaming chat endpoint (WAF-encoded bodies, `FetchKeys=llm_model_result`). */
export function qoderChatUrl(endpoints) {
    return `${endpoints.gateway}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
}
/** Model-catalog endpoint used by discovery. */
export function qoderModelListUrl(endpoints) {
    return `${endpoints.gateway}/algo/api/v2/model/list`;
}
function rsaEncryptBase64(data) {
    const encrypted = crypto.publicEncrypt({ key: QODER_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(data));
    return encrypted.toString("base64");
}
function aesEncryptCBCBase64(plaintext, keyStr) {
    const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr), Buffer.from(keyStr));
    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");
    return encrypted;
}
/** The path portion the gateway signs, with the `/algo` prefix stripped. */
export function computeQoderSigPath(urlStr) {
    const parsed = new URL(urlStr);
    let sigPath = parsed.pathname;
    if (sigPath.startsWith("/algo")) {
        sigPath = sigPath.substring("/algo".length);
    }
    return sigPath;
}
/**
 * OpenCode's data directory, used for the generated machine id.
 */
export function opencodeDataDir() {
    const override = process.env.OPENCODE_DATA_DIR?.trim();
    if (override)
        return override;
    const xdg = process.env.XDG_DATA_HOME?.trim();
    if (xdg)
        return join(xdg, "opencode");
    return join(homedir(), ".local", "share", "opencode");
}
/**
 * Persistable machine-id read in the qodercli / pi plugin order so an existing
 * install is recognised, generated once and stored under OpenCode's data dir
 * otherwise.
 */
export function getMachineId(dataDir = opencodeDataDir()) {
    const paths = [
        join(homedir(), ".qoder", ".auth", "machine_id"),
        join(homedir(), ".pi", "agent", "qoder-machine-id"),
        join(dataDir, "qoder-machine-id"),
    ];
    for (const p of paths) {
        if (existsSync(p)) {
            try {
                const val = readFileSync(p, "utf8").trim();
                if (val)
                    return val;
            }
            catch {
                // An unreadable fallback file is skipped; generation is the next step.
            }
        }
    }
    const newId = crypto.randomUUID();
    try {
        const savePath = paths[2];
        mkdirSync(dirname(savePath), { recursive: true });
        writeFileSync(savePath, newId, "utf8");
    }
    catch {
        // Persistence is best-effort; the generated id still signs this process.
    }
    return newId;
}
/**
 * Build the COSY signature headers for one request. The request body covered
 * by the signature is the WAF-encoded bytes sent on the wire.
 */
export function buildQoderAuthHeaders(body, requestURL, creds) {
    if (!creds.userID) {
        throw new Error("cosy: user id is empty");
    }
    if (!creds.authToken) {
        throw new Error("cosy: auth token is empty");
    }
    const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    const userInfo = {
        uid: creds.userID,
        security_oauth_token: creds.authToken,
        name: creds.name || "",
        aid: "",
        email: creds.email || "",
    };
    const infoB64 = aesEncryptCBCBase64(JSON.stringify(userInfo), aesKey);
    const cosyKey = rsaEncryptBase64(aesKey);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const requestId = crypto.randomUUID();
    const cosyPayload = {
        version: "v1",
        requestId,
        info: infoB64,
        cosyVersion: QODER_IDE_VERSION,
        ideVersion: "",
    };
    const payloadB64 = Buffer.from(JSON.stringify(cosyPayload)).toString("base64");
    const sigPath = computeQoderSigPath(requestURL);
    const bodyBuffer = body === null
        ? Buffer.alloc(0)
        : Buffer.isBuffer(body)
            ? body
            : typeof body === "string"
                ? Buffer.from(body, "utf8")
                : Buffer.from(body);
    const bodyStr = bodyBuffer.toString("utf8");
    const sigInput = `${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`;
    const sig = crypto.createHash("md5").update(sigInput).digest("hex");
    const bodyHash = crypto.createHash("md5").update(bodyBuffer).digest("hex");
    const bodyLen = bodyBuffer.length.toString();
    const machineID = creds.machineID || getMachineId();
    return {
        Authorization: `Bearer COSY.${payloadB64}.${sig}`,
        "Cosy-Key": cosyKey,
        "Cosy-User": creds.userID,
        "Cosy-Date": timestamp,
        "Cosy-Version": QODER_IDE_VERSION,
        "Cosy-Machineid": machineID,
        "Cosy-Machinetoken": machineID,
        "Cosy-Machinetype": QODER_MACHINE_TYPE_MAGIC,
        "Cosy-Machineos": QODER_MACHINE_OS,
        "Cosy-Clienttype": QODER_CLIENT_TYPE,
        "Cosy-Clientip": "127.0.0.1",
        "Cosy-Bodyhash": bodyHash,
        "Cosy-Bodylength": bodyLen,
        "Cosy-Sigpath": sigPath,
        "Cosy-Data-Policy": QODER_DATA_POLICY,
        "Cosy-Organization-Id": "",
        "Cosy-Organization-Tags": "",
        "Login-Version": QODER_LOGIN_VERSION,
        "X-Request-Id": crypto.randomUUID(),
    };
}
