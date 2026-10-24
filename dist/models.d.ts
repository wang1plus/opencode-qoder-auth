/**
 * Qoder model catalog: validation, `/algo/api/v2/model/list` discovery, and
 * translation into OpenCode `Model.Info` entries.
 */
import { Model, Provider } from "@opencode/plugin";
import { type QoderCnEndpoints } from "./cosy.js";
/** Default combined request/response context capacity. */
export declare const DEFAULT_CONTEXT_WINDOW = 1000000;
/** Default per-request output-token cap. */
export declare const DEFAULT_MAX_TOKENS = 32768;
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
/**
 * Validate and translate Qoder's model-list response into catalog entries.
 * Invalid individual records are ignored; an invalid or empty listing fails.
 */
export declare function parseQoderModelCatalog(value: unknown): QoderCatalogModel[];
/**
 * Translate one catalog entry into an OpenCode model definition.
 */
export declare function qoderModelToInfo(model: QoderCatalogModel, providerID: Provider.ID): Model.Info;
/**
 * Fetch and parse the live Qoder model catalog. A rejected cached job token is
 * invalidated and the request retried exactly once with a fresh exchange.
 */
export declare function fetchQoderModelCatalog(rawPat: string, endpoints: QoderCnEndpoints, machineId: string, signal?: AbortSignal): Promise<QoderCatalogModel[]>;
