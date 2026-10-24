/**
 * OpenCode v2 plugin for Qoder CN.
 *
 * Registers a Qoder provider backed by the generic `openai-compatible`
 * package, an integration with a PAT (`pt-...`) key method plus env methods,
 * live model discovery from `/algo/api/v2/model/list`, and session hooks that
 * rewrite standard OpenAI Chat requests into COSY-signed, WAF-encoded Qoder
 * envelopes and translate the double-enveloped Qoder SSE back to OpenAI SSE.
 */
import { Plugin } from "@opencode/plugin";
declare const _default: Plugin.Plugin;
export default _default;
