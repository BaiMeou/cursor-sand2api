[English](../limitations.md) | **中文**

# 限制

这是一个**转换器**，不是 OpenAI，不是 Cursor 官方 HTTP API，也不是完整的 agent 运行时。在你把网关或 SDK 接上去并假设对等之前，先读这一页。

## 不是完整的 OpenAI API

已实现（见 [api.md](./api.md)）：

- `POST /v1/chat/completions`
- `POST /v1/completions`（旧式文本；流式使用 `text_completion` 帧，id 为 `cmpl-…`）
- `POST /v1/responses` — 仅**无状态子集**
- `GET /v1/models` 和 `GET /v1/models/{id}`

诚实的 **501**（不是伪造的成功）：

- `GET` / `DELETE /v1/responses/{id}` — 什么都不存储
- `background: true`
- 托管 Responses 工具：`web_search`、`file_search`、`computer_use`、`code_interpreter`
- `/v1/embeddings`、`/v1/images/*`、`/v1/audio/*`、`/v1/moderations`

也未实现（校验或忽略，不是默默当成功）：

- `n > 1`
- `store`、assistants、files、fine-tuning、batches
- `logprobs` / `logit_bias` / `seed` 采样（发送时会在响应上列为 `cursor_ignored_params`）
- 远程 `https://` 图片或文件 URL（只上传 `data:` URL）
- 音频模态

`temperature` 和 `top_p` 在存在时会转发到 **InferenceService** 的 `modelConfig`。其它采样旋钮不会。

## 列出不是权益

`GET /v1/models` 是一份**目录**：每条 sand JWT 和每把 `crsr_` 密钥能*看见*的名字并集，外加元数据（上下文窗口、图片、思考）。它**不是**下一次补全一定会跑的承诺。

调用时 Cursor 仍可能返回：

| `error.code` | Typical cause |
|---|---|
| `plan_restricted` | 该会员不能跑那个**命名**模型（花费限额 / “upgrade or set a Spend Limit” / 免费套餐仅 Auto）。 |
| `unsupported_region` | 提供商对该账号或转换器的出口地区封锁。**Anthropic 模型从 CN 及其它地理受限路径经常 403。** |
| `rate_limit_exceeded` / `model_quota_exhausted` / `pro_rate_limit` | 周池、官方 API 额度，或按模型的套餐速率限制。 |
| `model_not_found` / `model_blocked` | slug 无效，或模型被闸到你接受其数据政策为止。 |
| `pool_exhausted` | 本进程没有所需类型的健康凭据（503）。 |

换模型、换池（`kimi-k3` 对 `api-kimi-k3`），或等待。不要把空的 `200` 目录未命中当成「模型存在」。未知 id 的 `GET /v1/models/{id}` 返回 **404**（经过本地别名后，例如 `gpt-4o` → `composer-2`）。

## 套餐桶不是一堆

同一个人可以持有若干 **不**共享剩余 token 的 Cursor 桶：

- **Sand / Bot 周池** — InferenceService 上默认 `x-cursor-client-type: sand`。
- **IDE “Other Models”** — `ide` / 缺失类型头，历史上走 `AgentService/Run`。
- **官方 User API Key** — `crsr_` / `api-*` id，`@cursor/sdk`，单独的 “API model usage” 额度。
- **SuperGrok / SuperGrok Heavy** — 面向 Grok 的周标签。该会员上的命名 Claude/Kimi 仍经常 `403` `plan_restricted`。**Grok Bot Plan** 标签才是被观察到能跑那些命名 slug 的 sand 桶。`PREFER_GROK_BOT_PLAN` 默认 **off**，以免转换器悄悄跳账号。

Grok Bot 桌面 `sendPrompt` **没有模型选择器**。它不是 Claude 路径，本仓库也未实现。

## 文档是实验性的

最后一条用户消息上的内联 `data:` **图片**会作为真正的 Inference/Agent 附件上传（大小限制：每张 5 MB，每回合 15 MB）。端到端检查里，模型能正确描述纯色 PNG。**kimi\* 在目录里不支持图片**（`supports_images=false`）；选一个有视觉能力的 id。

内联 `data:` **文档**（`file` / `input_file`，每个 10 MB，每回合 20 MB）使用同级的 `selectedDocuments` 字段。编码有单元测试覆盖。**没有端到端保证** Cursor 会像喂图片那样把那些字节喂给模型。不支持 `file_id`（没有 store）。

历史附件**不会**重新上传；它们在提示词里变成 “omitted” 占位符。

## `CONVERSATION_HISTORY` 是实验性的

`CONVERSATION_HISTORY=true` 把 Agent 路径历史作为 KV blob 发送，而不是压扁的用户文本。该组合在 `sand` + `connect+json` 上**尚未被证明**。漏掉 `kvClientMessage` 握手会让流一直挂到 `IDLE_TIMEOUT`。

默认 sand 聊天是 **InferenceService/Stream**：一元服务端流。工具结果不能写回同一条 HTTP/2 流；下一次 HTTP 请求重新 POST 完整的 OpenAI 消息列表（含 `role: tool`）。官方 `crsr_` 运行在 `tool_call_id` 仍映射到仍活着的会话时可以继续同一次 SDK run（约 10 分钟）。

## 没有 store

除了 `token.json` / `token-disabled.json` 和内存会话外，转换器跨重启是无状态的。

- Responses 的 `store` 永远是 **false**。
- `GET` / `DELETE /v1/responses/{id}` → **501**。
- `previous_response_id` 只当作**仍活着**的内存会话的 conversation id。

不要做指望按 id 取回上周二响应的客户端。

## Sand2api 不会注入你的项目规则

Cursor IDE Agent 会注入 `<user_info>`、`<rules>`、`AGENTS.md`、git 状态和 MCP 指令。本进程**不会**。它不会从磁盘读取 `/path/to/your/project/AGENTS.md` 再塞进模型。把指令放进 `messages[].role=system`、附加文件，或直接跑 Cursor。细节：[advanced/system-context.md](./advanced/system-context.md)。

## 其它锋利边

- 非官方；Cursor 随时可能弄坏协议（[免责声明](./disclaimer.md)）。
- Sand JWT ≠ 官方 `crsr_` ≠ Grok Bot 网关 token。
- 看起来匿名的 Cursor 路径上 `usage` 可能很稀疏；不要要求精确的 token 记账。
- 默认模型 `kimi-k3` 是一个**家族**。上游 sand 常常要变体 slug（`kimi-k3-max`、…）。转换器会映射；把裸的 `kimi-k3` 原样发给旧 Agent RPC 会被拒。
- 与 Cursor 内置冲突的工具名（`Read`、`WebSearch`、…）会在线路上改名，再映射回来。
- `TOOL_MODE=workspace` 在**本进程内**执行工具。那是本地调试，不是你应该暴露的远程 runner。
