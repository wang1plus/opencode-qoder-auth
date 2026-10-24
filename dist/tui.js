// src/tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { createMemo, createSignal, For, Show } from "solid-js";
var PROVIDER_ID = "qoder";
function formatTokens(value) {
  if (!value || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1e6) {
    const millions = value / 1e6;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(value);
}
function modelNotes(model) {
  const notes = [];
  if (model.compatibility?.reasoningField === "reasoning_content") notes.push("\u63A8\u7406");
  if (model.capabilities.tools) notes.push("\u5DE5\u5177");
  if (model.capabilities.input.includes("image")) notes.push("\u56FE\u7247");
  return notes;
}
function ModelCatalog(props) {
  const context = props.context;
  const theme = context.theme;
  const [open, setOpen] = createSignal(false);
  const [hoveredID, setHoveredID] = createSignal();
  const models = createMemo(() => {
    const session = context.data.session.get(props.sessionID);
    const list = context.data.location.model.list(session?.location ?? context.location) ?? [];
    return list.filter((model) => model.providerID === PROVIDER_ID).sort((a, b) => a.name.localeCompare(b.name));
  });
  return _$createComponent(Show, {
    get when() {
      return models().length > 0;
    },
    get children() {
      var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$4 = _$createElement("text"), _el$5 = _$createElement("b");
      _$insertNode(_el$, _el$2);
      _$setProp(_el$, "gap", 1);
      _$insertNode(_el$2, _el$3);
      _$insertNode(_el$2, _el$4);
      _$setProp(_el$2, "flexDirection", "row");
      _$setProp(_el$2, "gap", 1);
      _$setProp(_el$2, "onMouseDown", () => {
        setOpen((value) => !value);
        setHoveredID(void 0);
      });
      _$insert(_el$3, () => open() ? "\u25BC" : "\u25B6");
      _$insertNode(_el$4, _el$5);
      _$insertNode(_el$5, _$createTextNode(`Qoder \u6A21\u578B`));
      _$insert(_el$, _$createComponent(Show, {
        get when() {
          return open();
        },
        get children() {
          return _$createComponent(For, {
            get each() {
              return models();
            },
            children: (model) => {
              const notes = modelNotes(model);
              const hasDetails = notes.length > 0 || model.limit.context > 0 || model.limit.output > 0 || Boolean(model.settings?.reasoningEffort);
              return (() => {
                var _el$7 = _$createElement("box"), _el$8 = _$createElement("box"), _el$9 = _$createElement("text"), _el$0 = _$createTextNode(`\u2022 `), _el$1 = _$createElement("text");
                _$insertNode(_el$7, _el$8);
                _$setProp(_el$7, "gap", 0);
                _$insertNode(_el$8, _el$9);
                _$insertNode(_el$8, _el$1);
                _$setProp(_el$8, "flexDirection", "row");
                _$setProp(_el$8, "gap", 1);
                _$setProp(_el$8, "width", "100%");
                _$setProp(_el$8, "onMouseOver", () => setHoveredID(model.id));
                _$setProp(_el$8, "onMouseOut", () => setHoveredID((current) => current === model.id ? void 0 : current));
                _$insertNode(_el$9, _el$0);
                _$setProp(_el$9, "width", 26);
                _$setProp(_el$9, "flexShrink", 1);
                _$setProp(_el$9, "wrapMode", "none");
                _$setProp(_el$9, "truncate", true);
                _$insert(_el$9, () => model.name, null);
                _$insert(_el$1, () => notes.join("/"));
                _$insert(_el$7, _$createComponent(Show, {
                  get when() {
                    return hoveredID() === model.id && hasDetails;
                  },
                  get children() {
                    var _el$10 = _$createElement("box");
                    _$setProp(_el$10, "gap", 0);
                    _$setProp(_el$10, "marginLeft", 2);
                    _$insert(_el$10, _$createComponent(Show, {
                      get when() {
                        return model.limit.context > 0 || model.limit.output > 0;
                      },
                      get children() {
                        var _el$11 = _$createElement("text"), _el$12 = _$createTextNode(`\u4E0A\u4E0B\u6587 `), _el$13 = _$createTextNode(` \xB7 \u8F93\u51FA `);
                        _$insertNode(_el$11, _el$12);
                        _$insertNode(_el$11, _el$13);
                        _$insert(_el$11, () => formatTokens(model.limit.context) || "-", _el$13);
                        _$insert(_el$11, () => formatTokens(model.limit.output) || "-", null);
                        _$effect((_$p) => _$setProp(_el$11, "fg", theme.text.muted, _$p));
                        return _el$11;
                      }
                    }), null);
                    _$insert(_el$10, _$createComponent(Show, {
                      get when() {
                        return model.settings?.reasoningEffort;
                      },
                      get children() {
                        var _el$15 = _$createElement("text"), _el$16 = _$createTextNode(`\u9ED8\u8BA4\u63A8\u7406\u5F3A\u5EA6 `);
                        _$insertNode(_el$15, _el$16);
                        _$insert(_el$15, () => model.settings?.reasoningEffort, null);
                        _$effect((_$p) => _$setProp(_el$15, "fg", theme.text.muted, _$p));
                        return _el$15;
                      }
                    }), null);
                    _$insert(_el$10, _$createComponent(Show, {
                      get when() {
                        return notes.length > 0;
                      },
                      get children() {
                        var _el$17 = _$createElement("text"), _el$18 = _$createTextNode(`\u652F\u6301 `);
                        _$insertNode(_el$17, _el$18);
                        _$insert(_el$17, () => notes.join("\u3001"), null);
                        _$effect((_$p) => _$setProp(_el$17, "fg", theme.text.muted, _$p));
                        return _el$17;
                      }
                    }), null);
                    return _el$10;
                  }
                }), null);
                _$effect((_p$) => {
                  var _v$3 = theme.text.muted, _v$4 = theme.text.muted;
                  _v$3 !== _p$.e && (_p$.e = _$setProp(_el$9, "fg", _v$3, _p$.e));
                  _v$4 !== _p$.t && (_p$.t = _$setProp(_el$1, "fg", _v$4, _p$.t));
                  return _p$;
                }, {
                  e: void 0,
                  t: void 0
                });
                return _el$7;
              })();
            }
          });
        }
      }), null);
      _$effect((_p$) => {
        var _v$ = theme.text.base, _v$2 = theme.text.base;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$4, "fg", _v$2, _p$.t));
        return _p$;
      }, {
        e: void 0,
        t: void 0
      });
      return _el$;
    }
  });
}
var tui_default = Plugin.define({
  id: "qoder-auth-tui",
  setup(context) {
    void context.data.location.model.sync();
    const offModelUpdated = context.data.on("model.updated", (event) => {
      void context.data.location.model.sync(event.location);
    });
    const offSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => _$createComponent(ModelCatalog, {
        context,
        get sessionID() {
          return input.sessionID;
        }
      })
    });
    return () => {
      offModelUpdated();
      offSlot();
    };
  }
});
export {
  tui_default as default
};
