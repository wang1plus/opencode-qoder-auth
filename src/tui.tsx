/** @jsxImportSource @opentui/solid */
import type { ModelInfo } from "@opencode/client";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { createMemo, createSignal, For, Show } from "solid-js";

const PROVIDER_ID = "qoder";

function formatTokens(value: number | undefined): string {
  if (!value || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

function modelNotes(model: ModelInfo): string[] {
  const notes: string[] = [];
  if (model.compatibility?.reasoningField === "reasoning_content") notes.push("推理");
  if (model.capabilities.tools) notes.push("工具");
  if (model.capabilities.input.includes("image")) notes.push("图片");
  return notes;
}

function ModelCatalog(props: { context: Context; sessionID: string }) {
  const context = props.context;
  const theme = context.theme;
  const [open, setOpen] = createSignal(false);
  const [hoveredID, setHoveredID] = createSignal<string>();

  const models = createMemo(() => {
    const session = context.data.session.get(props.sessionID);
    const list =
      context.data.location.model.list(session?.location ?? context.location) ?? [];
    return list
      .filter((model) => model.providerID === PROVIDER_ID)
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  return (
    <Show when={models().length > 0}>
      <box gap={1}>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            setOpen((value) => !value);
            setHoveredID(undefined);
          }}
        >
          <text fg={theme.text.base}>{open() ? "▼" : "▶"}</text>
          <text fg={theme.text.base}>
            <b>Qoder 模型</b>
          </text>
        </box>
        <Show when={open()}>
          <For each={models()}>
            {(model) => {
              const notes = modelNotes(model);
              const hasDetails =
                notes.length > 0 ||
                model.limit.context > 0 ||
                model.limit.output > 0 ||
                Boolean(model.settings?.reasoningEffort);
              return (
                <box gap={0}>
                  <box
                    flexDirection="row"
                    gap={1}
                    width="100%"
                    onMouseOver={() => setHoveredID(model.id)}
                    onMouseOut={() =>
                      setHoveredID((current) =>
                        current === model.id ? undefined : current,
                      )
                    }
                  >
                    <text
                      fg={theme.text.muted}
                      width={26}
                      flexShrink={1}
                      wrapMode="none"
                      truncate={true}
                    >
                      • {model.name}
                    </text>
                    <text fg={theme.text.muted}>{notes.join("/")}</text>
                  </box>
                  <Show when={hoveredID() === model.id && hasDetails}>
                    <box gap={0} marginLeft={2}>
                      <Show when={model.limit.context > 0 || model.limit.output > 0}>
                        <text fg={theme.text.muted}>
                          上下文 {formatTokens(model.limit.context) || "-"} · 输出{" "}
                          {formatTokens(model.limit.output) || "-"}
                        </text>
                      </Show>
                      <Show when={model.settings?.reasoningEffort}>
                        <text fg={theme.text.muted}>
                          默认推理强度 {model.settings?.reasoningEffort}
                        </text>
                      </Show>
                      <Show when={notes.length > 0}>
                        <text fg={theme.text.muted}>支持 {notes.join("、")}</text>
                      </Show>
                    </box>
                  </Show>
                </box>
              );
            }}
          </For>
        </Show>
      </box>
    </Show>
  );
}

export default Plugin.define({
  id: "qoder-auth-tui",
  setup(context) {
    // Keep the sidebar model catalog in sync with the server plugin's dynamic
    // model discovery (including re-discovery after (re)login).
    void context.data.location.model.sync();
    const offModelUpdated = context.data.on("model.updated", (event) => {
      void context.data.location.model.sync(event.location);
    });

    const offSlot = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <ModelCatalog context={context} sessionID={input.sessionID} />
      ),
    });

    return () => {
      offModelUpdated();
      offSlot();
    };
  },
});
