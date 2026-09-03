[English](../api.md) | **中文**

# HTTP 接口

这些示例的 Base URL：`http://127.0.0.1:13000`。

设置了 `API_KEY` 时，每个 `/v1/*` 路由和 `GET /health/detail` 都需要：

```http
Authorization: Bearer changeme
```

`API_KEY` 为空时跳过该检查——**仅回环**。见 [配置](./configuration.md)。

已实现表面：

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/chat/completions` | 主要的 Chat Completions 门面 |
| `POST` | `/v1/completions` | 旧式 prompt → 同一后端 |
| `POST` | `/v1/responses` | 无状态 Responses 子集 |
| `GET` | `/v1/models` | 目录，**不是**权益 |
| `GET` | `/v1/models/{id}` | 未知则 404（经过别名后） |
| `GET` | `/health` | 公开，很小 |
| `GET` | `/health/detail` | 需要 `API_KEY` |

## Chat Completions

```http
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer changeme
```

```json
{
  "model": "kimi-k3",
  "stream": false,
  "workspace": "/path/to/your/project",
  "messages": [
    { "role": "system", "content": "Be brief." },
    { "role": "user", "content": "Reply with exactly: pong" }
  ]
}
```

`workspace` / `cwd` / 头 `X-Workspace`（或 `X-Cursor-Cwd`）是**给模型的上下文**（*你*机器上的路径）。它不会上传该目录，也不会注入 `AGENTS.md`。

### 映射了什么

| Request | Behavior |
|---|---|
| `messages[].role` `system` / `user` / `assistant` / `tool` / `function` / `developer` | `developer` → `system`。InferenceService 有真正的 SYSTEM 角色。 |
| `messages[].content` 字符串或数组 | `text` / `input_text` / `output_text`。 |
| `image_url` / `input_image` | 最后一条用户消息，仅 `data:` URL，作为附件上传。 |
| `file` / `input_file` | 同一回合，`data:` 文档。**实验性**——见 [限制](./limitations.md)。 |
| `tools` + `tool_choice` + `parallel_tool_calls` | OpenAI functions。`none` 拒绝工具。接受旧式 `functions` / `function_call`。 |
| `stream` | SSE。同一回合共用同一个 completion `id`。 |
| `stream_options.include_usage` | 结束后额外一块仅含 usage 的 chunk。Usage 也会搭在结束 chunk 上。 |
| `max_tokens` / `max_completion_tokens` / `stop` | 出口侧强制（截断时 `finish_reason: length`）。可能时也送到 Inference `modelConfig`。 |
| `temperature` / `top_p` | 转发到 Inference `modelConfig`。 |
| `reasoning_effort` / `reasoning.effort` / `thinking.effort` | 深度。`MODEL_PARAMETERS=on` 时映射到目录变体 slug。 |
| `response_format` `json_object` / `json_schema` | 提示词强制，不是服务端文法。 |
| `conversation_id` / 头 `X-Conversation-Id` | 当官方 SDK 路径还能 `submit` 工具结果时，恢复**仍活着**的内存会话（约 10 分钟）。InferenceService 改为重新 POST 历史。 |

被忽略的采样 / 存储旋钮会以 `cursor_ignored_params` 出现在响应上（例如 `seed`、`logprobs`、`store`）。

非流式成功是普通的 `chat.completion` 对象。思考是 `choices[0].message.reasoning_content`（以及 `reasoning`）。若上游只发了思考，该文本会被**提升**进 `content`，以免调用方一片沉默。

### 流式

`Content-Type: text/event-stream`。Chat 帧是 `object: "chat.completion.chunk"`。

- `textDelta` → `delta.content`
- 思考 → `delta.reasoning_content` 和 `delta.reasoning`
- 工具 → `delta.tool_calls`
- 结束 → `finish_reason` `stop` | `length` | `tool_calls`，然后 `data: [DONE]`

**流已经开始之后的错误**是**顶层**帧，然后 `[DONE]`：

```text
data: {"error":{"message":"…","type":"permission_error","code":"unsupported_region","cursor_error":"ERROR_UNSUPPORTED_REGION"}}

data: [DONE]
```

它们**不会**写进 `delta.content` 并带 `finish_reason: "stop"`。OpenAI SDK 只有看到顶层 `error` 键才会抛；旧的假 200 路径会让 agent 把错误当模型散文，也会让中继按成功计费。

若失败发生在**第一个 SSE 字节之前**，HTTP 状态是真实状态（401 / 403 / 429 / 503 / …），不是 200。

### 工具（`TOOL_MODE=client`，默认）

第 1 轮可能以 `finish_reason: "tool_calls"` 结束。在本地执行，然后 POST **完整**历史（标准 OpenAI）。在 InferenceService 上你不需要 `conversation_id`。

```json
{
  "model": "kimi-k3",
  "tools": [{ "type": "function", "function": { "name": "get_weather", "parameters": { "type": "object", "properties": { "city": { "type": "string" } } } } }],
  "messages": [
    { "role": "user", "content": "Weather in Taipei?" },
    {
      "role": "assistant",
      "tool_calls": [
        { "id": "call_xxx", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"Taipei\"}" } }
      ]
    },
    { "role": "tool", "tool_call_id": "call_xxx", "content": "{\"temp\":30}" }
  ]
}
```

见 [examples/tool-loop.sh](../../examples/tool-loop.sh)。`TOOL_MODE=workspace` 在本进程内跑内置工具（仅调试）。`TOOL_MODE=none` 拒绝工具。

与 Cursor 内置冲突的名字（`Read`、`WebSearch`、…）会在线路上改名，再映射回来。

## Completions（旧式）

```http
POST /v1/completions
```

`prompt` 被包成一条用户消息。流式使用 `object: "text_completion"` 和 id `cmpl-…`（不是 chat chunk）。这种方言会省略思考。

## Responses（子集）

```http
POST /v1/responses
```

与 chat 同一后端。已翻译：

- `input` — 字符串、消息项，或松散的内容部件
- `instructions` → system
- `max_output_tokens` → `max_tokens`
- `reasoning.effort` → `reasoning_effort`
- `text.format` → `response_format`
- 扁平 `{ "type": "function", "name", "parameters" }` 工具
- `function_call` / `function_call_output` 项回放 agent 循环
- `previous_response_id` → 仅作为仍活着的 conversation id

非流式 body 是 Responses `response` 对象，`store: false`。

流式是真正的 Responses 事件流（单调递增的 `sequence_number`，**没有 `[DONE]`**）：

`response.created` → `response.in_progress` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta` × N → `*.done` → `response.completed`（或 `max_tokens` 时的 `response.incomplete`）。

思考使用 `response.reasoning_summary_text.delta`。工具参数作为一条 `response.function_call_arguments.delta` 到达（Cursor 不会按 token 流式发参数）。

流失败会发出 `response.failed` 和顶层 `error` 事件——不是一个把错误文本写在 output 里的已完成响应。

### 501 表面

| Request | Result |
|---|---|
| `GET /v1/responses/{id}` | 501 `not_implemented` |
| `DELETE /v1/responses/{id}` | 501 `not_implemented` |
| `"background": true` | 501 |
| 托管工具 `web_search` / `file_search` / `computer_use` / `code_interpreter` | 501 |
| `POST /v1/embeddings` | 501 |
| `POST /v1/images/generations` 或 `/edits` | 501 |
| `POST /v1/audio/speech`、`/transcriptions`、`/translations` | 501 |
| `POST /v1/moderations` | 501 |

`n > 1` 是 **400** `unsupported_parameter`，不是 501。

## 模型

```http
GET /v1/models
GET /v1/models/{id}
```

各凭据目录的并集，去重。官方 id 加前缀 `api-`。额外字段（`context_window`、`supports_images`、`supports_thinking`、`display_name`、`aliases`）是非标准的；OpenAI SDK 会忽略它们。

**这份列表不是套餐权益。** 调用时仍可能遇到 `plan_restricted`、`unsupported_region` 和限流。见 [限制](./limitations.md)。

未知 `{id}` → **404** `model_not_found`。本地别名（例如 `gpt-4o` → `composer-2`）会解析到实际会跑的模型。

省略 `model` 时的默认：`kimi-k3`（`DEFAULT_MODEL`）。

## 健康检查

### `GET /health`（公开）

不需要 `API_KEY`。负载均衡应使用这个。

```json
{
  "status": "ok",
  "version": "1.0.0",
  "tokens": { "total": 2, "healthy": 2 }
}
```

`tokens.healthy > 0` 时 `status` 为 `ok`，否则为 `degraded`。没有账号名、没有用量 URL、没有工具设置。

### `GET /health/detail`（需鉴权）

鉴权与 `/v1/*` 相同。运维内部：默认模型、客户端类型/版本、工具模式、超时、实验标志、白名单、sand 用量（仪表盘 URL 已剥掉）。**不要在没有密钥的情况下暴露这条路由。**

## 错误 JSON

非流式失败使用真实 HTTP 状态，以及：

```json
{
  "error": {
    "message": "ERROR_UNSUPPORTED_REGION: …",
    "type": "permission_error",
    "param": null,
    "code": "unsupported_region",
    "hint": "This model provider is not available in the Cursor account or converter region. …",
    "cursor_error": "ERROR_UNSUPPORTED_REGION",
    "cursor_title": "",
    "cursor_detail": "…",
    "action_required": "",
    "retryable": false,
    "model": "claude-4.5-sonnet",
    "requested_model": "claude-4.5-sonnet"
  }
}
```

`error.code` 是**字符串**。调试字段可选。**不含账号名和邮箱。** Cursor 文案里的美元金额会被打码。

### 分类

| HTTP | `type` | `code` | When |
|---|---|---|---|
| 400 | `invalid_request_error` | `content_filter` | 提供商内容策略 |
| 400 | `invalid_request_error` | `model_not_found` | 坏 slug / 不在池里 |
| 400 | `invalid_request_error` | `context_length_exceeded` | 提示词太大 |
| 400 | `invalid_request_error` | `output_token_limit` | 输出上限 |
| 400 | `invalid_request_error` | `invalid_request` / `unsupported_parameter` | 校验 |
| 401 | `authentication_error` | `invalid_api_key` | 转换器密钥或 Cursor JWT/`crsr_` 被拒 |
| 403 | `permission_error` | `unsupported_region` | 地理 / 提供商地区封锁（从 CN 打 Anthropic 很常见） |
| 403 | `permission_error` | `plan_restricted` | 套餐不能跑该命名模型 |
| 403 | `permission_error` | `model_blocked` | 控制台闸门 |
| 403 | `permission_error` | `permission_denied` | 其它 403 |
| 429 | `rate_limit_error` | `rate_limit_exceeded` | 共享用量 / `resource_exhausted` |
| 429 | `rate_limit_error` | `model_quota_exhausted` | 该凭据上该模型的额度 |
| 429 | `rate_limit_error` | `pro_rate_limit` | 按模型的套餐速率限制 |
| 499 | `api_error` | `client_closed_request` | 调用方中止 |
| 501 | `invalid_request_error` | `not_implemented` | 上面的表面 |
| 502 | `api_error` | `upstream_error` | 未分类的 Cursor 失败 |
| 503 | `api_error` | `overloaded` | 提供商过载 |
| 503 | `server_error` | `pool_exhausted` | 没有所需类型的健康 sand JWT 或 `crsr_` |

`429` **不会**停用凭据（共享用量）。`unsupported_region` 不会故障转移到另一个账号（另一条 JWT 通常是同一地区）。`plan_restricted` **可以**故障转移到另一条 sand JWT。若一条都不剩，你会得到 **503** `pool_exhausted`，而不是假装完成的聊天。

仅当 `TOKEN_RATE_LIMIT_COOLDOWN_MS > 0` 时，`429` 才会发送 `Retry-After`。
