import type { Rpc } from "@opencode/plugin";

/**
 * Shared RPC contract between the server plugin (which owns the PAT and the
 * job-token cache) and the TUI plugin, which only has a client connection and
 * must not touch credentials itself.
 */
export const qoderBalanceRpc = {
  id: "qoder-auth",
  methods: {
    balance: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          remaining: { type: "number" },
          used: { type: "number" },
          total: { type: "number" },
          usedPercent: { type: "number" },
          exceeded: { type: "boolean" },
          shared: { type: "boolean" },
          plan: { type: ["string", "null"] },
          error: { type: "string" },
        },
        required: [
          "ok",
          "remaining",
          "used",
          "total",
          "usedPercent",
          "exceeded",
          "shared",
          "plan",
        ],
        additionalProperties: false,
      },
    },
  },
  events: {},
} satisfies Rpc.PortableDefinition;
