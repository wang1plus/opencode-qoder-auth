/**
 * Qoder model catalog: validation, `/algo/api/v2/model/list` discovery, and
 * translation into OpenCode `Model.Info` entries.
 */

import { Model, Provider } from "@opencode/plugin";
import {
  buildQoderAuthHeaders,
  qoderModelListUrl,
  type QoderCnEndpoints,
} from "./cosy.js";
import {
  QoderError,
  httpErrorCode,
  isAuthExpiredError,
  isAuthExpiredStatus,
} from "./errors.js";
import { ensureIdentity, ensureJobToken, invalidateJobToken } from "./session.js";

/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
/** Default per-request output-token cap. */
export const DEFAULT_MAX_TOKENS = 32_768;

/** One catalog model entry advertised by Qoder. */
export interface QoderCatalogModel {
  /** Exact upstream wire key used for model selection and generation. */
  id: string;
  /** Selector label. */
  name: string;
  /** Known combined request/response context capacity. */
  contextWindow: number;
  /** Per-request output cap. */
  maxTokens: number;
  /** Accepted request modalities. */
  inputModalities: ("text" | "image")[];
  /** Whether the wire model is a reasoning model. */
  reasoning: boolean;
  /** Reasoning effort ids advertised by `thinking_config`, in server order. */
  reasoningEfforts: string[];
  /** Default effort, when advertised. */
  defaultEffort?: string;
}

type DeepMutable<A> = A extends
  | null
  | undefined
  | boolean
  | number
  | bigint
  | string
  | symbol
  | ((...args: never[]) => unknown)
  ? A
  : A extends ReadonlyArray<infer I>
    ? Array<DeepMutable<I>>
    : A extends ReadonlyMap<infer K, infer V>
      ? Map<DeepMutable<K>, DeepMutable<V>>
      : A extends object
        ? { -readonly [K in keyof A]: DeepMutable<A[K]> }
        : A;

type MutableInfo = DeepMutable<Model.Info>;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function contextWindowOf(entry: Record<string, unknown>): number | undefined {
  const contexts = recordOf(entry.context_config);
  let listed: number | undefined;
  if (contexts !== undefined) {
    for (const value of Object.values(contexts)) {
      const context = recordOf(value);
      const tokenCount = positiveInteger(context?.token_count);
      if (tokenCount === undefined) continue;
      if (context?.is_default === true) return tokenCount;
      listed = listed === undefined ? tokenCount : Math.max(listed, tokenCount);
    }
  }
  return positiveInteger(entry.max_input_tokens) ?? listed;
}

function reasoningConfigOf(entry: Record<string, unknown>): {
  efforts: string[];
  defaultEffort?: string;
} {
  const thinking = recordOf(entry.thinking_config);
  if (thinking === undefined) return { efforts: [] };
  const enabled = recordOf(thinking.enabled) ?? thinking;
  const efforts = recordOf(enabled.efforts) ?? recordOf(thinking.efforts);
  if (efforts === undefined) return { efforts: [] };

  const names = Object.keys(efforts).filter((name) => {
    const value = efforts[name];
    return value === true || recordOf(value) !== undefined;
  });
  let defaultEffort: string | undefined;
  for (const name of names) {
    if (recordOf(efforts[name])?.is_default === true) {
      defaultEffort = name;
      break;
    }
  }
  if (defaultEffort === undefined && names.length > 0) {
    defaultEffort = names.includes("high")
      ? "high"
      : names.includes("max")
        ? "max"
        : names[0];
  }
  return { efforts: names, ...(defaultEffort ? { defaultEffort } : {}) };
}

/**
 * Validate and translate Qoder's model-list response into catalog entries.
 * Invalid individual records are ignored; an invalid or empty listing fails.
 */
export function parseQoderModelCatalog(value: unknown): QoderCatalogModel[] {
  const root = recordOf(value);
  if (!Array.isArray(root?.chat)) {
    throw new QoderError('Qoder CN model listing has no "chat" array', {
      code: "DISCOVERY_FAILED",
    });
  }
  const seen = new Set<string>();
  const models: QoderCatalogModel[] = [];
  for (const value of root.chat) {
    const entry = recordOf(value);
    const key = typeof entry?.key === "string" ? entry.key.trim() : "";
    if (key.length === 0 || entry?.enable !== true) continue;
    const display =
      typeof entry.display_name === "string" && entry.display_name.trim().length > 0
        ? entry.display_name.trim()
        : key;
    if (seen.has(key)) continue;
    seen.add(key);

    const reasoningConfig = reasoningConfigOf(entry);
    models.push({
      id: key,
      name: display,
      contextWindow: contextWindowOf(entry) ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: positiveInteger(entry.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
      inputModalities: entry.is_vl === true ? ["text", "image"] : ["text"],
      reasoning:
        entry.is_reasoning === true ||
        recordOf(entry.thinking_config) !== undefined,
      reasoningEfforts: reasoningConfig.efforts,
      ...(reasoningConfig.defaultEffort
        ? { defaultEffort: reasoningConfig.defaultEffort }
        : {}),
    });
  }
  if (models.length === 0) {
    throw new QoderError(
      "Qoder CN model listing contains no enabled usable models",
      { code: "DISCOVERY_FAILED" },
    );
  }
  return models;
}

/**
 * Translate one catalog entry into an OpenCode model definition.
 */
export function qoderModelToInfo(
  model: QoderCatalogModel,
  providerID: Provider.ID,
): Model.Info {
  const info = Model.Info.default(
    providerID,
    Model.ID.make(model.id),
  ) as unknown as MutableInfo;

  info.name = model.name || model.id;
  info.limit = {
    context: model.contextWindow,
    output: model.maxTokens,
  };
  info.capabilities = {
    tools: true,
    input: [...model.inputModalities],
    output: ["text"],
  };

  if (model.reasoning) {
    info.compatibility = {
      ...(info.compatibility ?? {}),
      reasoningField: "reasoning_content",
    };
    const defaultEffort = model.defaultEffort ?? "high";
    info.settings = {
      ...(info.settings ?? {}),
      reasoningEffort: defaultEffort,
    };
    if (model.reasoningEfforts.length > 0) {
      const efforts = model.reasoningEfforts.filter(
        (effort) => effort.toLowerCase() !== "off",
      );
      info.variants = [
        {
          id: Model.VariantID.make("off"),
          settings: { reasoningEffort: "off" },
        },
        ...efforts.map((effort) => ({
          id: Model.VariantID.make(effort),
          settings: { reasoningEffort: effort },
        })),
      ];
    }
  }

  return info;
}

/**
 * Fetch and parse the live Qoder model catalog. A rejected cached job token is
 * invalidated and the request retried exactly once with a fresh exchange.
 */
export async function fetchQoderModelCatalog(
  rawPat: string,
  endpoints: QoderCnEndpoints,
  machineId: string,
  signal?: AbortSignal,
): Promise<QoderCatalogModel[]> {
  const url = qoderModelListUrl(endpoints);

  for (let attempt = 0; ; attempt++) {
    let jobToken: string;
    let identity: { userID: string; email: string; name: string };
    try {
      jobToken = await ensureJobToken(rawPat, endpoints, { signal });
      identity = await ensureIdentity(rawPat, jobToken, endpoints, { signal });
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      if (attempt === 0 && isAuthExpiredError(error)) {
        invalidateJobToken(endpoints, rawPat);
        continue;
      }
      throw error;
    }

    const headers = buildQoderAuthHeaders(null, url, {
      userID: identity.userID,
      authToken: jobToken,
      name: identity.name,
      email: identity.email,
      machineID: machineId,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal,
      });
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      throw new QoderError(
        `Could not reach Qoder CN model listing at ${url}`,
        { code: "DISCOVERY_FAILED", cause: error },
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      if (attempt === 0 && isAuthExpiredStatus(response.status)) {
        invalidateJobToken(endpoints, rawPat);
        continue;
      }
      throw new QoderError(
        `Qoder CN model listing answered HTTP ${response.status}${
          detail.length > 0 ? `: ${detail.slice(0, 200)}` : ""
        }`,
        { code: httpErrorCode(response.status, detail), status: response.status },
      );
    }

    let value: unknown;
    try {
      value = await response.json();
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      throw new QoderError(
        "Qoder CN model listing did not answer with JSON",
        { code: "DISCOVERY_FAILED", cause: error },
      );
    }
    return parseQoderModelCatalog(value);
  }
}
