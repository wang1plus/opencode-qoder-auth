/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import {
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { QoderBalance } from "./quota.js";
import { qoderBalanceRpc } from "./rpc.js";

const PROVIDER_ID = "qoder";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const BAR_WIDTH = 10;

function formatCredits(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function progressBar(percent: number): string {
  const used = Math.min(Math.max(percent, 0), 100);
  const filled = Math.round((used / 100) * BAR_WIDTH);
  return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

function failed(message: string): QoderBalance {
  return {
    ok: false,
    remaining: 0,
    used: 0,
    total: 0,
    usedPercent: 0,
    exceeded: false,
    shared: false,
    plan: null,
    error: message,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("额度请求超时")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function BalancePanel(props: { context: Context; sessionID: string }) {
  const context = props.context;
  const theme = context.theme;
  const rpc = context.client.rpc(qoderBalanceRpc);
  const [tick, setTick] = createSignal(0);

  const [balance] = createResource(tick, async () => {
    try {
      const result = await withTimeout(rpc.balance({}), REQUEST_TIMEOUT_MS);
      return (result ?? failed("额度接口没有返回数据")) as QoderBalance;
    } catch (error: unknown) {
      return failed(error instanceof Error ? error.message : "额度请求失败");
    }
  });

  const refresh = () => {
    if (balance.loading) return;
    setTick((value) => value + 1);
  };

  const usedPercent = createMemo(() =>
    Math.min(Math.max(balance()?.usedPercent ?? 0, 0), 100),
  );

  onMount(() => {
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    const offUpdated = context.data.on("credential.updated", refresh);
    const offSwitched = context.data.on("credential.switched", (event) => {
      if (event.data.integrationID === PROVIDER_ID) refresh();
    });
    // Credits are consumed per turn, so the end of a turn is the moment the
    // number on screen goes stale.
    const offIdle = context.data.on("session.idle", (event) => {
      if (event.data.sessionID === props.sessionID) refresh();
    });
    onCleanup(() => {
      clearInterval(timer);
      offUpdated();
      offSwitched();
      offIdle();
    });
  });

  return (
    <box gap={1}>
      <box flexDirection="row" gap={1} onMouseDown={refresh}>
        <text fg={theme.text.base}>
          <b>Qoder 积分</b>
        </text>
        <text fg={theme.text.muted}>
          {balance.loading ? "刷新中…" : "↻"}
        </text>
      </box>
      <Show when={balance()} fallback={<text fg={theme.text.muted}>加载中…</text>}>
        {(summary) => (
          <Show
            when={summary().ok}
            fallback={
              <text fg={theme.text.muted}>{summary().error || "积分不可用"}</text>
            }
          >
            <box gap={0}>
              <box flexDirection="row" gap={1}>
                <text fg={theme.text.base}>
                  <b>{formatCredits(summary().remaining)}</b>
                </text>
                <text fg={theme.text.muted}>剩余积分</text>
              </box>
              <text fg={theme.text.muted}>
                已用 {formatCredits(summary().used)}
                <Show when={summary().total > 0}>
                  {" / "}
                  {formatCredits(summary().total)}
                </Show>
              </text>
              <box flexDirection="row" gap={1}>
                <text fg={theme.text.base}>{progressBar(usedPercent())}</text>
                <text fg={theme.text.muted}>
                  {usedPercent().toFixed(0)}%
                </text>
              </box>
              <Show when={summary().plan || summary().shared || summary().exceeded}>
                <text fg={theme.text.muted}>
                  {[
                    summary().plan,
                    summary().shared ? "共享额度" : "",
                    summary().exceeded ? "额度已用尽" : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </text>
              </Show>
            </box>
          </Show>
        )}
      </Show>
    </box>
  );
}

export default Plugin.define({
  id: "qoder-auth-tui",
  setup(context) {
    const offSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <BalancePanel context={context} sessionID={input.sessionID} />
      ),
    });

    return () => {
      offSlot();
    };
  },
});
