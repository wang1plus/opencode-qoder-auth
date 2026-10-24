// src/tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { createMemo, createResource, createSignal, onCleanup, onMount, Show } from "solid-js";

// src/rpc.ts
var qoderBalanceRpc = {
  id: "qoder-auth",
  methods: {
    balance: {
      input: {
        type: "object",
        properties: {},
        additionalProperties: false
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
          error: { type: "string" }
        },
        required: [
          "ok",
          "remaining",
          "used",
          "total",
          "usedPercent",
          "exceeded",
          "shared",
          "plan"
        ],
        additionalProperties: false
      }
    }
  },
  events: {}
};

// src/tui.tsx
var PROVIDER_ID = "qoder";
var REFRESH_INTERVAL_MS = 5 * 60 * 1e3;
var REQUEST_TIMEOUT_MS = 15e3;
var BAR_WIDTH = 10;
function formatCredits(value) {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}
function progressBar(percent) {
  const used = Math.min(Math.max(percent, 0), 100);
  const filled = Math.round(used / 100 * BAR_WIDTH);
  return `${"\u2588".repeat(filled)}${"\u2591".repeat(BAR_WIDTH - filled)}`;
}
function failed(message) {
  return {
    ok: false,
    remaining: 0,
    used: 0,
    total: 0,
    usedPercent: 0,
    exceeded: false,
    shared: false,
    plan: null,
    error: message
  };
}
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("\u989D\u5EA6\u8BF7\u6C42\u8D85\u65F6")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
function BalancePanel(props) {
  const context = props.context;
  const theme = context.theme;
  const rpc = context.client.rpc(qoderBalanceRpc);
  const [tick, setTick] = createSignal(0);
  const [balance] = createResource(tick, async () => {
    try {
      const result = await withTimeout(rpc.balance({}), REQUEST_TIMEOUT_MS);
      return result ?? failed("\u989D\u5EA6\u63A5\u53E3\u6CA1\u6709\u8FD4\u56DE\u6570\u636E");
    } catch (error) {
      return failed(error instanceof Error ? error.message : "\u989D\u5EA6\u8BF7\u6C42\u5931\u8D25");
    }
  });
  const refresh = () => {
    if (balance.loading) return;
    setTick((value) => value + 1);
  };
  const usedPercent = createMemo(() => Math.min(Math.max(balance()?.usedPercent ?? 0, 0), 100));
  onMount(() => {
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    const offUpdated = context.data.on("credential.updated", refresh);
    const offSwitched = context.data.on("credential.switched", (event) => {
      if (event.data.integrationID === PROVIDER_ID) refresh();
    });
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
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("b"), _el$6 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "gap", 1);
    _$insertNode(_el$2, _el$3);
    _$insertNode(_el$2, _el$6);
    _$setProp(_el$2, "flexDirection", "row");
    _$setProp(_el$2, "gap", 1);
    _$setProp(_el$2, "onMouseDown", refresh);
    _$insertNode(_el$3, _el$4);
    _$insertNode(_el$4, _$createTextNode(`Qoder \u79EF\u5206`));
    _$insert(_el$6, () => balance.loading ? "\u5237\u65B0\u4E2D\u2026" : "\u21BB");
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return balance();
      },
      get fallback() {
        return (() => {
          var _el$7 = _$createElement("text");
          _$insertNode(_el$7, _$createTextNode(`\u52A0\u8F7D\u4E2D\u2026`));
          _$effect((_$p) => _$setProp(_el$7, "fg", theme.text.muted, _$p));
          return _el$7;
        })();
      },
      children: (summary) => _$createComponent(Show, {
        get when() {
          return summary().ok;
        },
        get fallback() {
          return (() => {
            var _el$20 = _$createElement("text");
            _$insert(_el$20, () => summary().error || "\u79EF\u5206\u4E0D\u53EF\u7528");
            _$effect((_$p) => _$setProp(_el$20, "fg", theme.text.muted, _$p));
            return _el$20;
          })();
        },
        get children() {
          var _el$9 = _$createElement("box"), _el$0 = _$createElement("box"), _el$1 = _$createElement("text"), _el$10 = _$createElement("b"), _el$11 = _$createElement("text"), _el$13 = _$createElement("text"), _el$14 = _$createTextNode(`\u5DF2\u7528 `), _el$15 = _$createElement("box"), _el$16 = _$createElement("text"), _el$17 = _$createElement("text"), _el$18 = _$createTextNode(`%`);
          _$insertNode(_el$9, _el$0);
          _$insertNode(_el$9, _el$13);
          _$insertNode(_el$9, _el$15);
          _$setProp(_el$9, "gap", 0);
          _$insertNode(_el$0, _el$1);
          _$insertNode(_el$0, _el$11);
          _$setProp(_el$0, "flexDirection", "row");
          _$setProp(_el$0, "gap", 1);
          _$insertNode(_el$1, _el$10);
          _$insert(_el$10, () => formatCredits(summary().remaining));
          _$insertNode(_el$11, _$createTextNode(`\u5269\u4F59\u79EF\u5206`));
          _$insertNode(_el$13, _el$14);
          _$insert(_el$13, () => formatCredits(summary().used), null);
          _$insert(_el$13, _$createComponent(Show, {
            get when() {
              return summary().total > 0;
            },
            get children() {
              return [" / ", _$memo(() => formatCredits(summary().total))];
            }
          }), null);
          _$insertNode(_el$15, _el$16);
          _$insertNode(_el$15, _el$17);
          _$setProp(_el$15, "flexDirection", "row");
          _$setProp(_el$15, "gap", 1);
          _$insert(_el$16, () => progressBar(usedPercent()));
          _$insertNode(_el$17, _el$18);
          _$insert(_el$17, () => usedPercent().toFixed(0), _el$18);
          _$insert(_el$9, _$createComponent(Show, {
            get when() {
              return summary().plan || summary().shared || summary().exceeded;
            },
            get children() {
              var _el$19 = _$createElement("text");
              _$insert(_el$19, () => [summary().plan, summary().shared ? "\u5171\u4EAB\u989D\u5EA6" : "", summary().exceeded ? "\u989D\u5EA6\u5DF2\u7528\u5C3D" : ""].filter(Boolean).join(" \xB7 "));
              _$effect((_$p) => _$setProp(_el$19, "fg", theme.text.muted, _$p));
              return _el$19;
            }
          }), null);
          _$effect((_p$) => {
            var _v$3 = theme.text.base, _v$4 = theme.text.muted, _v$5 = theme.text.muted, _v$6 = theme.text.base, _v$7 = theme.text.muted;
            _v$3 !== _p$.e && (_p$.e = _$setProp(_el$1, "fg", _v$3, _p$.e));
            _v$4 !== _p$.t && (_p$.t = _$setProp(_el$11, "fg", _v$4, _p$.t));
            _v$5 !== _p$.a && (_p$.a = _$setProp(_el$13, "fg", _v$5, _p$.a));
            _v$6 !== _p$.o && (_p$.o = _$setProp(_el$16, "fg", _v$6, _p$.o));
            _v$7 !== _p$.i && (_p$.i = _$setProp(_el$17, "fg", _v$7, _p$.i));
            return _p$;
          }, {
            e: void 0,
            t: void 0,
            a: void 0,
            o: void 0,
            i: void 0
          });
          return _el$9;
        }
      })
    }), null);
    _$effect((_p$) => {
      var _v$ = theme.text.base, _v$2 = theme.text.muted;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$6, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$;
  })();
}
var tui_default = Plugin.define({
  id: "qoder-auth-tui",
  setup(context) {
    const offSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => _$createComponent(BalancePanel, {
        context,
        get sessionID() {
          return input.sessionID;
        }
      })
    });
    return () => {
      offSlot();
    };
  }
});
export {
  BalancePanel,
  tui_default as default
};
