/**
 * OpenCode v2 plugin for Qoder CN.
 *
 * Registers a Qoder provider backed by the generic `openai-compatible`
 * package, an integration with a PAT (`pt-...`) key method plus env methods,
 * live model discovery from `/algo/api/v2/model/list`, and session hooks that
 * rewrite standard OpenAI Chat requests into COSY-signed, WAF-encoded Qoder
 * envelopes and translate the double-enveloped Qoder SSE back to OpenAI SSE.
 */
import { Integration, Plugin, Provider, } from "@opencode/plugin";
import { getMachineId, getQoderCNPat, isQoderPatValue, resolveQoderEndpoints, } from "./cosy.js";
import { QoderError, errorCodeOf, isAuthExpiredDetail, isAuthExpiredStatus, upstreamErrorDetail, } from "./errors.js";
import { fetchQoderModelCatalog, qoderModelToInfo, } from "./models.js";
import { buildQoderChatRequest, resignQoderRequest, } from "./request.js";
import { invalidateJobToken } from "./session.js";
import { peekQoderSseAuth, transformQoderResponse, } from "./stream.js";
const PROVIDER_ID = "qoder";
const PROVIDER_NAME = "Qoder";
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible";
const AUTH_LABEL = "Qoder 个人访问令牌 (PAT, pt-...)";
/**
 * Env vars accepted by the integration `env` method. `QODER_API_KEY` is only
 * honored when its value is a PAT; a raw API key is not a Qoder credential.
 */
const ENV_NAMES = [
    "QODERCN_PERSONAL_ACCESS_TOKEN",
    "QODERCN_PAT",
    "QODER_API_KEY",
];
/** Latest `providers.qoder.settings.baseURL` seen in a provider transform. */
let configuredBaseURL;
/** In-flight request metadata keyed by `X-Qoder-Request-Id`. */
const requestMetaByID = new Map();
/** In-flight request metadata keyed by the exact Request object. */
const requestMetaByRequest = new WeakMap();
/**
 * Resolve the active Qoder PAT. The host-injected credential wins over the
 * environment so chat and discovery use the same account.
 */
async function resolveCurrentPat(ctx) {
    try {
        const connection = await ctx.integration.connection.active(PROVIDER_ID);
        if (connection) {
            const credential = await ctx.integration.connection.resolve(connection);
            if (credential?.type === "key" && credential.key.trim()) {
                return credential.key.trim();
            }
            if (credential?.type === "oauth" && credential.access.trim()) {
                return credential.access.trim();
            }
        }
    }
    catch {
        // A missing/inactive connection falls back to the environment.
    }
    return getQoderCNPat();
}
/**
 * Discover the current model inventory. `undefined` means discovery failed and
 * the previous inventory should be retained; an empty array means the user is
 * not authenticated and the provider should expose no models.
 */
async function refreshModelSource(ctx) {
    const pat = await resolveCurrentPat(ctx);
    if (!pat)
        return [];
    const providerID = Provider.ID.make(PROVIDER_ID);
    const endpoints = resolveQoderEndpoints(configuredBaseURL);
    try {
        const catalog = await fetchQoderModelCatalog(pat, endpoints, getMachineId());
        return catalog.map((model) => qoderModelToInfo(model, providerID));
    }
    catch (error) {
        console.error(`[qoder] model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
/**
 * Merge discovered models without overwriting user-declared entries.
 *
 * `injectedIDs` tracks the model IDs this plugin installed on a previous pass
 * (or before a `provider.reload()`), so a catalog refresh can replace its own
 * entries while entries declared in the user's config always win — including
 * when both share the same ID.
 */
function mergeModels(existing, discovered, injectedIDs) {
    const declared = existing.filter((model) => !injectedIDs.has(model.id));
    const declaredIDs = new Set(declared.map((model) => model.id));
    const installed = discovered.filter((model) => !declaredIDs.has(model.id));
    return {
        models: [...declared, ...installed],
        injected: new Set(installed.map((model) => model.id)),
    };
}
/**
 * Build an OpenAI-style error response for a Qoder JSON error body so the
 * host's provider-error classifier sees a proper status.
 */
function qoderJsonErrorResponse(text, status) {
    const code = errorCodeOf(text);
    const auth = isAuthExpiredDetail(text) || isAuthExpiredStatus(status);
    return new Response(JSON.stringify({
        error: {
            message: upstreamErrorDetail(text) || "Qoder request failed",
            ...(code === undefined ? {} : { code }),
        },
    }), {
        status: auth ? 401 : status >= 400 ? status : 502,
        headers: { "content-type": "application/json" },
    });
}
export default Plugin.define({
    id: "qoder-auth",
    async setup(ctx) {
        const providerID = Provider.ID.make(PROVIDER_ID);
        const integrationID = Integration.ID.make(PROVIDER_ID);
        let currentModels = [];
        // Model IDs installed by discovery, as opposed to user-declared entries.
        const injectedModelIDs = new Set();
        const applyProviderTransform = async () => {
            await ctx.provider.transform((editor) => {
                const existing = editor.get(PROVIDER_ID);
                if (!existing) {
                    editor.add({
                        info: {
                            ...Provider.Info.empty(providerID),
                            name: PROVIDER_NAME,
                            activation: "auto",
                            package: PROVIDER_PACKAGE,
                            integrationID,
                            compatibility: { maxTokensField: "max_tokens" },
                            settings: {
                                baseURL: resolveQoderEndpoints(configuredBaseURL).gateway,
                            },
                        },
                        models: [],
                    });
                    return;
                }
                // A user-declared `providers.qoder` block is honored: keep its baseURL
                // (public/VPC switch), fill in the runtime package when omitted, and
                // never overwrite user-declared models.
                editor.update(PROVIDER_ID, (provider) => {
                    if (!provider.package)
                        provider.package = PROVIDER_PACKAGE;
                    if (!provider.integrationID)
                        provider.integrationID = integrationID;
                    provider.compatibility = {
                        ...(provider.compatibility ?? {}),
                        maxTokensField: "max_tokens",
                    };
                    const baseURL = provider.settings?.baseURL;
                    if (typeof baseURL === "string" && baseURL) {
                        configuredBaseURL = baseURL;
                    }
                    else {
                        provider.settings = {
                            ...(provider.settings ?? {}),
                            baseURL: resolveQoderEndpoints(configuredBaseURL).gateway,
                        };
                    }
                });
                const merged = mergeModels([...existing.models.values()], currentModels, injectedModelIDs);
                injectedModelIDs.clear();
                for (const id of merged.injected)
                    injectedModelIDs.add(id);
                editor.models.set(PROVIDER_ID, merged.models);
            });
        };
        // First pass registers the provider and captures a user-declared
        // `settings.baseURL` so discovery targets the same public/VPC endpoint set
        // as chat. Discovery then runs and a second pass installs the models.
        await applyProviderTransform();
        currentModels = (await refreshModelSource(ctx)) ?? currentModels;
        await applyProviderTransform();
        await ctx.integration.transform((editor) => {
            editor.update(PROVIDER_ID, (integration) => {
                integration.name = PROVIDER_NAME;
            });
            editor.method.update({
                integrationID,
                method: { type: "key", label: AUTH_LABEL },
            });
            editor.method.update({
                integrationID,
                method: { type: "env", names: ENV_NAMES },
            });
        });
        // Standard OpenAI Chat body -> Qoder agent envelope.
        await ctx.session.hook("http.request", async (event) => {
            const original = event.request;
            // The core may replay a hook-modified request on retry; leave an
            // already-signed Qoder request untouched.
            if (original.headers.get("x-qoder-request-id"))
                return;
            let pat = original.headers
                .get("authorization")
                ?.replace(/^Bearer\s+/i, "")
                .trim() ?? "";
            if (!pat)
                pat = await resolveCurrentPat(ctx);
            if (!pat) {
                throw new Error("未登录 Qoder，请先执行 `opencode auth login qoder` 并输入 PAT (pt-...)，" +
                    "或设置 QODERCN_PERSONAL_ACCESS_TOKEN / QODERCN_PAT。");
            }
            if (!isQoderPatValue(pat)) {
                throw new Error("Qoder 需要个人访问令牌 (pt-...)。请在 https://qoder.com.cn 生成 PAT 后重新登录。");
            }
            let body;
            try {
                body = (await original.clone().json());
            }
            catch (error) {
                throw new QoderError("Qoder request body is not valid JSON", {
                    code: "INVALID_REQUEST",
                    cause: error,
                });
            }
            const model = typeof body.model === "string" && body.model.trim()
                ? body.model.trim()
                : String(event.model.id);
            const endpoints = resolveQoderEndpoints(configuredBaseURL);
            const built = await buildQoderChatRequest({
                pat,
                endpoints,
                machineId: getMachineId(),
                model,
                body,
                sessionScope: String(event.sessionID),
                provider: String(event.model.providerID),
                kind: event.kind,
                signal: original.signal,
            });
            requestMetaByID.set(built.meta.requestID, built.meta);
            requestMetaByRequest.set(built.request, built.meta);
            event.request = built.request;
        }, { providerID: PROVIDER_ID });
        // Qoder SSE / auth retry -> standard OpenAI SSE.
        await ctx.session.hook("http.response", async (event) => {
            const requestID = event.request.headers.get("x-qoder-request-id");
            const meta = (requestID ? requestMetaByID.get(requestID) : undefined) ??
                requestMetaByRequest.get(event.request);
            if (requestID)
                requestMetaByID.delete(requestID);
            const retry = async () => {
                if (!meta || meta.retried)
                    return undefined;
                meta.retried = true;
                invalidateJobToken(meta.endpoints, meta.pat);
                const request = await resignQoderRequest(meta, {
                    signal: event.request.signal,
                    force: true,
                });
                requestMetaByID.set(meta.requestID, meta);
                requestMetaByRequest.set(request, meta);
                return fetch(request);
            };
            const finalize = async (response) => {
                if (!response.ok || !response.body)
                    return response;
                const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
                if (contentType.includes("application/json")) {
                    const text = await response.clone().text().catch(() => "");
                    if (isAuthExpiredDetail(text) && meta && !meta.retried) {
                        const retried = await retry();
                        if (retried)
                            return finalize(retried);
                    }
                    return qoderJsonErrorResponse(text, response.status);
                }
                const peeked = await peekQoderSseAuth(response);
                if (peeked.authExpired && meta && !meta.retried) {
                    await peeked.response.body?.cancel().catch(() => { });
                    const retried = await retry();
                    if (retried)
                        return finalize(retried);
                    return peeked.response;
                }
                return transformQoderResponse(peeked.response, {
                    model: meta?.model ?? String(event.model.id),
                });
            };
            let response = event.response;
            if (!response.ok &&
                isAuthExpiredStatus(response.status) &&
                meta &&
                !meta.retried) {
                const retried = await retry();
                if (retried)
                    response = retried;
            }
            event.response = await finalize(response);
        }, { providerID: PROVIDER_ID });
        // Re-discover models whenever a credential or the active connection
        // changes at this location.
        const controller = new AbortController();
        const locationDirectory = ctx.location.directory;
        void (async () => {
            try {
                for await (const event of ctx.event.subscribe({
                    signal: controller.signal,
                })) {
                    if (event.type !== "credential.updated" &&
                        event.type !== "credential.switched") {
                        continue;
                    }
                    if (event.location?.directory &&
                        event.location.directory !== locationDirectory) {
                        continue;
                    }
                    if (event.type === "credential.switched" &&
                        event.data.integrationID !== PROVIDER_ID) {
                        continue;
                    }
                    const refreshed = await refreshModelSource(ctx);
                    if (refreshed === undefined)
                        continue;
                    currentModels = refreshed;
                    await ctx.provider.reload();
                }
            }
            catch (error) {
                if (!controller.signal.aborted) {
                    console.error(`[qoder] credential event subscription failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        })();
        return () => {
            controller.abort();
            requestMetaByID.clear();
        };
    },
});
