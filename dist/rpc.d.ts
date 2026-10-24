/**
 * Shared RPC contract between the server plugin (which owns the PAT and the
 * job-token cache) and the TUI plugin, which only has a client connection and
 * must not touch credentials itself.
 */
export declare const qoderBalanceRpc: {
    id: string;
    methods: {
        balance: {
            input: {
                type: string;
                properties: {};
                additionalProperties: boolean;
            };
            output: {
                type: string;
                properties: {
                    ok: {
                        type: string;
                    };
                    remaining: {
                        type: string;
                    };
                    used: {
                        type: string;
                    };
                    total: {
                        type: string;
                    };
                    usedPercent: {
                        type: string;
                    };
                    exceeded: {
                        type: string;
                    };
                    shared: {
                        type: string;
                    };
                    plan: {
                        type: string[];
                    };
                    error: {
                        type: string;
                    };
                };
                required: string[];
                additionalProperties: boolean;
            };
        };
    };
    events: {};
};
