# opencode-qoder-auth

OpenCode v2 插件，用于 Qoder 国内版（Qoder CN）认证。使用个人访问令牌（PAT，`pt-...`）登录后，即可在 OpenCode 中使用 Qoder 的对话模型。插件会自动从 `/algo/api/v2/model/list` 发现账号可用模型，处理 Qoder 的 COSY 签名、WAF 编码和双层 SSE 流，并在 TUI 侧边栏提供模型目录。

> **V2 版本**：本插件基于 OpenCode v2（`@opencode/plugin`，`Plugin.define` + Promise API）。V1 的 `config` / `auth` / loader hooks 不会被 v2 宿主加载。

## 安装

本插件通过 Git 仓库安装，源码托管在 <https://github.com/wang1plus/opencode-qoder-auth>。

在 `opencode.json`（项目 `.opencode/opencode.json` 或全局 `~/.config/opencode/opencode.jsonc`）中添加插件：

```jsonc
{
  "plugins": ["github:wang1plus/opencode-qoder-auth"]
}
```

或使用命令安装（会自动写入 `plugins` 并安装依赖）：

```bash
opencode plugin add github:wang1plus/opencode-qoder-auth
```

默认跟随仓库默认分支更新，服务器启动时会自动检查更新；如需固定版本，可追加 `#<分支|标签|commit>`，例如 `github:wang1plus/opencode-qoder-auth#v2.0.0`。手动更新已安装的插件：

```bash
opencode plugin update github:wang1plus/opencode-qoder-auth
```

### 三种配置方式，任选其一

#### 方式一：只加插件（推荐）

不声明 provider，provider 和 models 全部由插件自动创建与发现：

```jsonc
{
  "plugins": ["github:wang1plus/opencode-qoder-auth"]
}
```

#### 方式二：声明 provider，自动发现 models

手动声明 provider 配置，但无需写 models（插件启动时自动注入）：

```jsonc
{
  "plugins": ["github:wang1plus/opencode-qoder-auth"],
  "providers": {
    "qoder": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "Qoder",
      "settings": {
        "baseURL": "https://gateway.qoder.com.cn"
      }
    }
  }
}
```

#### 方式三：手动声明 models

完全手动控制模型列表。插件不会覆盖已有条目，仅在缺失时补充发现到的模型：

```jsonc
{
  "plugins": ["github:wang1plus/opencode-qoder-auth"],
  "providers": {
    "qoder": {
      "package": "@opencode/ai/providers/openai-compatible",
      "name": "Qoder",
      "settings": {
        "baseURL": "https://gateway.qoder.com.cn"
      },
      "models": {
        "qwen3-coder-plus": {
          "name": "Qwen3 Coder Plus",
          "limit": { "context": 200000, "output": 65536 }
        }
      }
    }
  }
}
```

> 插件启动时通过 provider transform 创建/补充 `providers.qoder`，并在登录后通过 `credential.*` 事件重新发现模型并刷新 provider。手动声明的模型始终优先，不会被覆盖。未登录时不会请求模型列表，因此 provider 下暂时没有模型。

## 登录

```bash
opencode auth login qoder
```

按提示粘贴 Qoder 个人访问令牌（PAT，`pt-...`）。PAT 在 Qoder 客户端的账号设置中生成（查找 Personal Access Token / PAT 相关入口）。凭据保存在本地数据库，由插件注册的 `key` 方法管理；`opencode auth list` 可查看已保存的账号，`opencode auth logout qoder` 可退出。

也可以不登录，直接用环境变量提供 PAT：

```bash
export QODERCN_PERSONAL_ACCESS_TOKEN=pt-xxxxxxxx
opencode
```

PAT 只用于换取短期 job token（`jt-...`），不会直接作为 API 凭据发送。

## 查看可用模型

```bash
opencode models | grep qoder
```

也可以直接运行 `opencode models` 查看全部模型。交互式选择：在 OpenCode 内输入 `/model` 搜索 qoder。

模型目录来自 `GET {gateway}/algo/api/v2/model/list`：

- `chat[].key` — 上游模型 ID（请求时使用）
- `chat[].display_name` — 展示名称
- `chat[].enable` — 仅启用（`true`）的模型会被注入
- `chat[].context_config` — 上下文窗口（优先 `is_default`，否则取最大值）
- `chat[].max_output_tokens` — 单次输出上限
- `chat[].is_vl` — 是否支持图片输入
- `chat[].is_reasoning` / `thinking_config` — 推理能力与可选推理强度

模型列表会在以下时机刷新：插件启动、登录/切换凭据（`credential.updated` / `credential.switched`）、`opencode reload`。接口失败时保留上一次成功发现的列表。

## 推理（Reasoning）支持

对目录中标记为推理模型的条目，插件会写入：

- `compatibility.reasoningField = "reasoning_content"`，让 OpenCode 识别 Qoder 返回的推理增量
- `settings.reasoningEffort`，默认取 `thinking_config` 的 `is_default`，否则优先 `high` / `max`
- 模型变体：`off` 加上目录声明的强度（如 `low` / `medium` / `high`）

选择 `off` 变体时，请求中的 `is_reasoning` 为 `false`，且不会发送 `reasoning_effort`。选择其它变体时，`reasoning_effort` 会写入 Qoder 的 `parameters`。

如果上游把推理内容以 `<thinking>...</thinking>`、`<think>`、`<reasoning>` 或 `<thought>` 标签混在正文里返回，插件会把它拆成 `reasoning_content`，并保持正文连续。

命令行验证：

```bash
opencode run --model qoder/qwen3-coder-plus --format json --thinking '只回答 OK'
```

输出中应包含 `"type":"reasoning"` 事件，随后是 `"type":"text"`。

## 环境变量

| 变量 | 说明 | 必需 |
|------|------|------|
| `QODERCN_PERSONAL_ACCESS_TOKEN` | Qoder PAT（优先） | 否 |
| `QODERCN_PAT` | Qoder PAT（`QODERCN_PERSONAL_ACCESS_TOKEN` 未设置时使用） | 否 |
| `QODER_API_KEY` | 兼容变量；仅当值为 `pt-...` 时才作为 PAT 使用 | 否 |
| `QODER_VPC_INSTANCE` | 企业 VPC 实例名（如 `acme`） | 否 |
| `QODER_GATEWAY_URL` | 显式覆盖 gateway 地址 | 否 |
| `QODER_OPENAPI_URL` | 显式覆盖 OpenAPI 地址 | 否 |
| `QODER_MANAGE_URL` | 显式覆盖管理台地址（仅展示/诊断用） | 否 |
| `OPENCODE_DATA_DIR` | 覆盖 OpenCode 数据目录（machine-id 存放位置） | 否 |
| `XDG_DATA_HOME` | 未设置 `OPENCODE_DATA_DIR` 时决定数据目录 | 否 |

PAT 解析优先级：`QODERCN_PERSONAL_ACCESS_TOKEN` → `QODERCN_PAT` → `QODER_API_KEY`（仅 `pt-...`）。宿主注入的登录凭据优先于环境变量，保证对话和模型发现使用同一个账号。

## 公网 vs 企业 VPC

默认使用公网端点：

| 用途 | 公网地址 |
|------|---------|
| Gateway（对话 / 模型列表） | `https://gateway.qoder.com.cn` |
| OpenAPI（token / userinfo） | `https://openapi.qoder.com.cn` |
| 管理台 | `https://qoder.com.cn` |

企业 VPC 实例 `acme` 对应：

| 用途 | VPC 地址 |
|------|---------|
| Gateway | `https://acme-gateway.vpc.qoder.com.cn` |
| OpenAPI | `https://acme-openapi.vpc.qoder.com.cn` |
| 管理台 | `https://acme.vpc.qoder.com.cn` |

推荐通过环境变量指定实例：

```bash
export QODER_VPC_INSTANCE=acme
opencode
```

也可以只改 provider 的 `baseURL`，插件会从中解析实例名，并让**模型发现和对话使用同一套端点**：

```jsonc
{
  "plugins": ["github:wang1plus/opencode-qoder-auth"],
  "providers": {
    "qoder": {
      "settings": {
        "baseURL": "https://acme-gateway.vpc.qoder.com.cn"
      }
    }
  }
}
```

端点解析优先级：显式 `QODER_GATEWAY_URL` + `QODER_OPENAPI_URL`（需同时设置）→ VPC 相关变量 → provider `settings.baseURL` → 公网默认值。

> VPC 环境需要能解析并访问 `*.vpc.qoder.com.cn`，通常要求处于企业内网或已连接 VPN。若只配置了 gateway 而 OpenAPI 不可达，登录换 token 会失败。

## TUI 侧边栏

TUI 侧边栏展示当前账号的 Qoder 模型目录（默认折叠，点击标题展开）。将鼠标移到模型名称上时显示详情（推理/工具/图片/上下文/输出限制、默认推理强度）。基于 v2 `ui.slot` 渲染，不跟踪当前选择。

使用 `opencode plugin add` 安装后 TUI 会自动启用（写入 `tui.json` 的 `plugin` 数组）。也可手动配置，在 `~/.config/opencode/tui.json`（或项目 `.opencode/tui.json`）加入：

```json
{
  "plugin": ["github:wang1plus/opencode-qoder-auth"]
}
```

修改配置后需要完全退出并重新启动 OpenCode。

## 工作原理

```
OpenCode v2 插件 (@opencode/plugin, Plugin.define)
  ├─ setup → ctx.provider.transform（两遍）
  │           第一遍：创建/补充 providers.qoder
  │             package=@opencode/ai/providers/openai-compatible
  │             activation=auto, integrationID=qoder
  │             compatibility.maxTokensField=max_tokens
  │             settings.baseURL=<gateway>，并捕获用户声明的 VPC baseURL
  │           然后：GET /algo/api/v2/model/list 发现模型
  │           第二遍：注入 models（不覆盖用户手动声明的条目）
  ├─ setup → ctx.integration.transform
  │           注册 "key" 方法（PAT pt-...）与 "env" 方法
  │           （QODERCN_PERSONAL_ACCESS_TOKEN / QODERCN_PAT / QODER_API_KEY）
  ├─ ctx.session.hook("http.request", …, { providerID: "qoder" })
  │           读取宿主注入的 bearer（PAT），缺失时回退 connection.resolve()
  │           OpenAI Chat body → Qoder agent envelope
  │           WAF 编码 → COSY 签名 → 改写 event.request
  ├─ ctx.session.hook("http.response", …)
  │           401/403 或 in-band code 105 → 换新 job token 重签并重试一次
  │           Qoder 双层 SSE → 标准 OpenAI SSE（含 [DONE]）
  └─ ctx.event.subscribe
            监听 credential.updated / credential.switched（按目录 + integrationID 过滤）
            重新发现模型并 ctx.provider.reload()
```

### 请求改写

OpenCode 的 `openai-compatible` provider 生成标准 OpenAI Chat 请求。Qoder 的 `agent_chat_generation` 需要更大的 agent envelope，插件会：

1. 把 `system` / `developer` 消息提取到顶层 `system` 字段
2. 规范化用户消息（保留文本与 `image_url` 内容块）
3. 把 assistant 的 `reasoning_content` 折叠回 `<thinking>` 标签，保证多轮推理上下文
4. 为只有工具调用的 assistant 消息补 `(tool call)` 占位内容
5. 为空的工具结果补 `(no output)`
6. 写入 `parameters.max_tokens`、可选 `parameters.reasoning_effort`、`model_config`、`chat_context` 等字段
7. 对完整 JSON 做 WAF 编码（`Encode=1`），再用 COSY 头签名
8. 附加 `X-Qoder-Request-Id`，用于关联请求与响应、重试时复用同一份已编码 body

### 响应转换

Qoder 返回的是双层 SSE：

```
data: {"statusCodeValue":200,"body":"<JSON 字符串或 [DONE]>"}
```

插件把它转换为 OpenCode 能解析的普通 OpenAI SSE：

- `choices[].delta.content` / `reasoning_content` / `tool_calls` 原样映射
- 缺失 `finish_reason` 时根据内容推断 `stop` / `tool_calls`
- 上游错误 envelope 转为 OpenAI `error` 事件
- 只有推理没有正文、空响应、被截断的工具调用会转成明确错误，避免静默成功
- 流结束始终补一个 `data: [DONE]`

### 认证与重试

- PAT 按 endpoint 集合缓存在进程内，换取 `jt-...`；job token 在接近过期或超过 30 分钟时主动轮换
- 网关返回 401/403 或 `{"code":"105"}`（登录过期）时，插件丢弃缓存的 job token，强制重新 exchange，重新签名同一份请求体并重试一次
- 模型发现也使用相同的 job token / COSY 逻辑，并在被拒绝时重试一次
- machine-id 优先复用 `~/.qoder/.auth/machine_id`、`~/.pi/agent/qoder-machine-id`，否则生成并保存到 OpenCode 数据目录

## 故障排查

### 登录后仍然没有模型

1. 确认 PAT 以 `pt-` 开头，而不是 `jt-` / `sk-`。
2. 运行 `opencode auth list` 确认 qoder 凭据存在；必要时 `opencode auth login qoder` 重新登录。
3. 确认能访问 `https://gateway.qoder.com.cn`（或对应 VPC 地址）。
4. 查看 OpenCode 日志中的 `[qoder] model discovery failed` 信息。
5. 模型目录变化后，重新登录或运行 `opencode reload` 触发刷新。

### 401 / 403 / `code 105`

PAT 被撤销、过期或账号无权限时会返回这类错误。插件会自动重试一次；若仍失败：

1. 重新生成 PAT 并 `opencode auth login qoder`。
2. 检查系统时间是否准确（COSY 签名包含时间戳）。
3. VPC 用户确认 gateway 与 OpenAPI 指向同一个实例。

### `QODER_INCOMPLETE_RESPONSE` / `QODER_EMPTY_RESPONSE`

上游只返回了推理、没有最终答案或结构化工具调用。通常是模型/网关的临时问题，重试即可；如果持续出现，尝试切换模型或推理强度。

### `MALFORMED_RESPONSE` / `QODER_STREAM_CLOSED`

响应不是预期的 Qoder SSE 格式，或连接在首帧前关闭。常见原因：代理缓冲/改写了 SSE、VPC 网关不匹配、网络中断。确认代理对 `text/event-stream` 关闭缓冲。

### TUI 侧边栏不显示

1. 确认 `tui.json` 的 `plugin` 数组包含本插件。
2. 完全退出并重新启动 OpenCode（不是仅关闭会话）。
3. 先确认 `opencode models` 中已有 qoder 模型。

## 开发

```bash
npm install
npm run build      # tsc 编译到 dist/ + esbuild 打包 TUI -> dist/tui.js
npm run typecheck  # 仅类型检查
npm test           # 构建后运行 node:test 测试
```

源码结构：

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 插件入口：provider / integration 注册、HTTP hooks、认证重试、模型刷新 |
| `src/cosy.ts` | 端点推导、COSY 签名头、machine-id、PAT 环境变量 |
| `src/pat.ts` | PAT → job token 交换、refresh、userinfo |
| `src/session.ts` | job token / identity 进程内缓存与保守轮换 |
| `src/models.ts` | 模型目录解析、`/model/list` 发现、OpenCode `Model.Info` 映射 |
| `src/request.ts` | OpenAI body → Qoder envelope、WAF 编码、COSY 签名、重签 |
| `src/stream.ts` | Qoder 双层 SSE → OpenAI SSE、认证过期探测、空/不完整响应保护 |
| `src/qoder-encoding.ts` | WAF body 编解码 |
| `src/thinking-parser.ts` | `<thinking>` 等标签的流式推理拆分 |
| `src/errors.ts` | 错误分类与 401/403 / `code 105` 判定 |
| `src/tui.tsx` | TUI 侧边栏模型目录 |

### 本地加载

OpenCode v2 的插件加载器支持 npm registry 或 git spec，`file://` 和 `.opencode/plugin.ts` 写法不会被加载。本地联调建议：

1. 推送到 Git 仓库后 `opencode plugin add github:wang1plus/opencode-qoder-auth`；
2. 或将构建产物替换到已解析的缓存包（npm 安装位于 `~/.cache/opencode/npm/`，git 安装位于 `~/.cache/opencode/git/`）。

修改源码后重新构建并完全退出重启 OpenCode：

```bash
npm run build
opencode
```

## 致谢

本项目的插件架构与 Qoder 线路实现参考了以下开源项目，感谢作者们的开源工作：

- [dsh-codebuddy-auth](https://github.com/cainiao1992/dsh-codebuddy-auth) — DeepSeek Harness 的 CodeBuddy provider 插件，本项目的 provider 注册、凭据管理和模型同步思路来源于此。
- [opencode-codebuddy-auth](https://github.com/kuops/opencode-codebuddy-auth) — OpenCode v2 插件结构的直接模板。
- [dsh-provider-qoder](https://github.com/minglu6/dsh-provider-qoder) — Qoder CN 的 PAT 交换、COSY 签名、WAF 编码和双层 SSE 实现参考。

## 许可证

MIT
