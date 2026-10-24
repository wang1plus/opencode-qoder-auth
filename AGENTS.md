# AGENTS.md

## 项目概述

OpenCode v2 插件，为 Qoder 国内版（Qoder CN）提供 PAT 认证、动态模型发现、COSY 签名请求和双层 SSE 转换。双入口：

- `src/index.ts` — server 插件（provider / integration / session hooks）
- `src/tui.tsx` — TUI 侧边栏插件（模型目录）

provider ID、integration ID 均为 `qoder`；登录命令为 `opencode auth login qoder`。

## 构建与测试

```bash
npm install
npm run compile      # tsc 编译到 dist/ + esbuild 打包 TUI -> dist/tui.js
npm run typecheck  # 仅类型检查
npm test           # npm run compile && node --test test/*.test.mjs
```

- 测试直接导入 `dist/*.js`，因此必须先构建；`npm test` 已包含编译。
- 当前 52 个测试，覆盖编码、COSY、推理拆分、模型目录、token 缓存、请求构造、SSE 转换和插件端到端流程。
- 无 lint、无 CI。
- `src/index.ts` → `dist/index.js`（tsc）；`src/tui.tsx` → `dist/tui.js`（`build.tui.mjs`，external 为 `@opencode/*`、`@opentui/*`、`solid-js`）。

## 架构要点

基于 `@opencode/plugin` v2（Promise API）：`Plugin.define({ id, setup(ctx) })`，default export。peerDependencies 为 `@opencode/plugin: ^2.1.4`、`@opentui/*`、`solid-js`。

### setup(ctx) 流程

1. **provider.transform（两遍）**
   - 第一遍创建/补充 `providers.qoder`：`package: "@opencode/ai/providers/openai-compatible"`、`activation: "auto"`、`integrationID: "qoder"`、`compatibility.maxTokensField: "max_tokens"`、`settings.baseURL`。
   - 第一遍同时捕获用户声明的 `settings.baseURL` 到模块级 `configuredBaseURL`，使 VPC 路由对模型发现生效。
   - 第一遍之后调用 `refreshModelSource(ctx)`（`GET /algo/api/v2/model/list`），第二遍用 `editor.models.set` 注入模型；用户手动声明的同 ID 模型优先。
   - 注入的模型 ID 记录在 `injectedModelIDs`，刷新时只替换插件自己注入的条目，用户声明的条目（包括与发现模型同 ID 的）始终保留。
2. **integration.transform**
   - 注册 `key` 方法（PAT `pt-...`，无 `id`）和 `env` 方法（`QODERCN_PERSONAL_ACCESS_TOKEN`、`QODERCN_PAT`、`QODER_API_KEY`）。
   - `integration.name = "Qoder"`。
3. **session.hook("http.request", …, { providerID: "qoder" })**
   - 从 `authorization` 读取宿主注入的 PAT；缺失时回退 `ctx.integration.connection.active()/resolve()`，再回退环境变量。
   - 校验 PAT 以 `pt-` 开头（`isQoderPatValue`）。
   - `buildQoderChatRequest`：OpenAI body → Qoder envelope → WAF 编码 → COSY 签名 → 新 `Request`。
   - 用 `X-Qoder-Request-Id` 和 `WeakMap<Request>` 保存 `QoderRequestMeta`，供响应 hook 使用。
   - 已带 `x-qoder-request-id` 的请求直接跳过（宿主可能重放 hook）。
4. **session.hook("http.response", …)**
   - 通过 `X-Qoder-Request-Id` / WeakMap 找回 meta，并立即从 Map 删除（WeakMap 仍在）。
   - HTTP 401/403、JSON body 的 `code 105`、或 SSE 首帧的 401/403 / `code 105` → 失效缓存、强制重新 exchange、`resignQoderRequest` 重签同一份已编码 body、`fetch` 重试一次。
   - 非 SSE 的 JSON 错误转成 OpenAI `error` 结构。
   - 正常 SSE → `transformQoderResponse`。
5. **event.subscribe**
   - 监听 `credential.updated` / `credential.switched`，按 `location.directory` 和 `integrationID` 过滤。
   - 重新发现模型，成功后 `ctx.provider.reload()`。
   - cleanup 时 abort subscription 并清空请求 Map。

## 模块职责

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 插件入口、provider/integration 注册、hooks、认证重试、模型刷新 |
| `src/cosy.ts` | 公网/VPC 端点推导、COSY 头、machine-id、PAT 环境变量 |
| `src/pat.ts` | PAT exchange、job-token refresh、userinfo |
| `src/session.ts` | job-token / identity 缓存与轮换 |
| `src/models.ts` | `/model/list` 解析、`Model.Info` 映射、推理变体 |
| `src/request.ts` | OpenAI body → Qoder envelope、WAF 编码、签名、重签 |
| `src/stream.ts` | Qoder SSE → OpenAI SSE、认证探测、错误/空响应保护 |
| `src/qoder-encoding.ts` | WAF body 编解码 |
| `src/thinking-parser.ts` | `<thinking>` 等标签的流式拆分 |
| `src/errors.ts` | `QoderError`、状态分类、`code 105` 判定 |
| `src/tui.tsx` | TUI 侧边栏模型目录 |

## 线路协议（wire facts）

- 公网 gateway：`https://gateway.qoder.com.cn`
- 公网 OpenAPI：`https://openapi.qoder.com.cn`
- VPC：`https://<instance>-gateway.vpc.qoder.com.cn` / `https://<instance>-openapi.vpc.qoder.com.cn`
- Chat：`${gateway}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
- 模型列表：`${gateway}/algo/api/v2/model/list`
- PAT exchange：`POST ${openapi}/api/v1/jobToken/exchange`，body `{ personal_token }`
- Refresh：`POST ${openapi}/api/v1/jobToken/refresh`，body `{ refresh_token }`
- Userinfo：`GET ${openapi}/api/v1/userinfo`，`Authorization: Bearer <jobToken>`
- Qoder SSE：`data: {"statusCodeValue":200,"body":"<JSON 字符串或 [DONE]>"}`；结束可能是 `data: [DONE]`，也可能直接 EOF。
- COSY 签名覆盖 **WAF 编码后的 body**；`Cosy-Sigpath` 去掉 `/algo` 前缀。
- `Authorization: Bearer COSY.<base64(payload)>.<md5(payloadB64\ncosyKey\ntimestamp\nbody\nsigPath)>`
- job token 广告 TTL 为 24h，但网关可能提前拒绝；插件在 30 分钟或临近过期时主动轮换。
- `expires_in` 单位是毫秒。
- machine-id 查找顺序：`~/.qoder/.auth/machine_id` → `~/.pi/agent/qoder-machine-id` → `<OpenCode data dir>/qoder-machine-id`（生成并保存）。

## 模型发现

- 解析 `chat` 数组；仅 `enable === true` 且 `key` 非空；按 `key` 去重。
- 上下文：`context_config` 中 `is_default: true` 优先，否则取最大 `token_count`；再回退 `max_input_tokens`，最后默认 1,000,000。
- 输出上限：`max_output_tokens`，默认 32,768。
- 图片：`is_vl === true` → `input: ["text", "image"]`。
- 推理：`is_reasoning === true` 或存在 `thinking_config`。
- 推理强度来自 `thinking_config.enabled.efforts`（回退 `thinking_config.efforts`），`is_default` 决定默认值，否则优先 `high` / `max` / 第一项。
- `qoderModelToInfo` 写入 `compatibility.reasoningField = "reasoning_content"`、`settings.reasoningEffort`，并生成 `off` + 各强度变体。
- `Model.Info` 是只读窄类型；模块内用 `DeepMutable` 后再赋值。
- 发现失败返回 `undefined`（保留旧列表）；未登录返回 `[]`（不暴露模型）。

## 请求构造

- 系统/开发者消息提升到顶层 `system`。
- assistant 的 `reasoning_content` 折叠为 `<thinking>...</thinking>`；只有工具调用的 assistant 消息补 `(tool call)`；空工具结果补 `(no output)`。
- `max_tokens` 优先 `body.max_tokens`，回退 `max_completion_tokens`，最后默认 32,768。
- `reasoning_effort` 为 `off` / `none` / `disabled` / `false` 时视为关闭推理：`is_reasoning: false` 且不发送 `reasoning_effort`。
- `session_id` / `chat_record_id` 由 endpoint、userID、provider、model、session scope、kind 和消息内容哈希得到，稳定且可复现。
- 重试复用 `meta.encodedBody`，只重新生成 COSY 头（body 与 token 无关）。

## 测试约定

- 测试从 `../dist/*.js` 导入，修改源码后必须 `npm run compile`。
- 测试会替换 `globalThis.fetch`；使用 `clearQoderSessionCaches()` 清理模块级 token/identity 缓存。
- `test/plugin.test.mjs` 用 mock context 模拟 `provider.transform`、`integration.transform`、`session.hook`、`event.subscribe`。
- mock 的 `provider.transform` 是同步立即执行的；真实宿主可能延迟执行，但两遍 transform 的设计对两种时序都成立。
- 插件测试中通过 `createContext({ providerBaseURL })` 显式声明 baseURL，避免模块级 `configuredBaseURL` 在测试之间泄漏。
- 新增 VPC/端点相关测试时，注意 `resolveQoderEndpoints` 优先读环境变量；`test/cosy.test.mjs` 的 `withEnv` 会保存/恢复环境。

## 已知坑 / 注意点

- **不要用 `build` / `prepare` 作为脚本名**：bun 安装 git 依赖时会执行 `prepare`（没有时回退 `build`），而 opencode 内嵌运行环境里这一步必然失败，报 `NpmInstallFailedError: git dep preparation failed`。构建脚本命名为 `compile`，且 `dist/` 必须提交进仓库（git 安装不会构建）。
- **`[DONE]` 必须绕过 `terminal` 守卫**：`stream.ts` 的 `enqueue` 在 `terminal` 为 true 后丢弃数据；终止哨兵用单独的 `emitDone()` 直接 `controller.enqueue`。
- **SSE 首帧探测必须等到换行**：首个网络 chunk 可能把 `data:` JSON 截断；`peekQoderSseAuth` 先累积到出现 `\n` 再解析，EOF 时再做一次兜底解析。
- **OpenCode OpenAI Chat 解析器要求 `finish_reason`**（`requireFinishReason: true`）：转换器必须在结束前显式发出 `finish_reason`，否则宿主报错。
- **`maxTokensField`**：provider 级 `compatibility.maxTokensField = "max_tokens"`，否则 openai-compatible 可能发 `max_completion_tokens`。
- **`Uint8Array` body 类型**：TS 的 `BodyInit` 不接受 `Uint8Array<ArrayBufferLike>`；`new Request(..., { body })` 处使用 `as unknown as BodyInit`。
- **`X-Qoder-Request-Id`**：响应 hook 只能拿到 `Request`；用该头和 WeakMap 关联 meta。响应到达后从 Map 删除，避免泄漏。
- **`configuredBaseURL` 是模块级全局**：多 location 场景共享；当前两遍 transform 保证同一 setup 内发现与对话端点一致。若未来支持多 location 不同端点，需要改为按目录/连接键存储。
- **模型合并要区分来源**：`mergeModels` 依据 `injectedModelIDs` 判断哪些条目是插件自己注入的；只有这些条目会被新目录替换，用户声明的同 ID 模型必须保留。
- **PAT vs job token**：`QODER_API_KEY` 只有 `pt-` 开头才接受；不要把 `jt-` 或 `sk-` 当 PAT。
- **`isAuthExpiredDetail` 的正则**：匹配 `"code":105` / `"code":"105"`，不要写成未转义的 `\s`。
- **工具调用完整性**：`finish_reason: tool_calls` 但没有结构化工具调用时转成 `QODER_INCOMPLETE_RESPONSE`；只有推理没有正文时转成同类错误；完全空响应转成 `QODER_EMPTY_RESPONSE`。
- **空 `tool_calls: []`**：Qoder 可能不返回空数组；若遇到，转换器只映射非空调用，不会误触发工具调用。
- **模型发现请求也走 COSY**：不是简单的 Bearer GET；必须用 job token + `buildQoderAuthHeaders`。
- **VPC 只配 gateway 不够**：exchange/userinfo 走 OpenAPI；必须同时可达，或设置 `QODER_VPC_INSTANCE` 让两者一起推导。

## 环境与仓库

- OpenCode v2.1.4，命令 `opencode`。
- npm registry 使用国内镜像 `https://registry.npmmirror.com`。
- 仓库当前未配置 remote；README 中的安装地址假设为 `github:wang1plus/opencode-qoder-auth`，如实际仓库不同需同步修改。
- 所有源码与文档改动默认保持未提交，提交前检查 `git status`。
