# HTTP API

**English** | [中文](./zh/api.md)

Base URL in these examples: `http://127.0.0.1:13000`.

When `API_KEY` is set, every `/v1/*` route and `GET /health/detail` require:

```http
Authorization: Bearer changeme
```

When `API_KEY` is empty, that check is skipped — **loopback only**. See [configuration](./configuration.md).

Implemented surface:

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/chat/completions` | Primary Chat Completions facade |
| `POST` | `/v1/completions` | Legacy prompt → same backend |
| `POST` | `/v1/responses` | Stateless Responses subset |
| `GET` | `/v1/models` | Catalog, **not** entitlement |
| `GET` | `/v1/models/{id}` | 404 if unknown (after aliases) |
| `GET` | `/health` | Public, tiny |
| `GET` | `/health/detail` | Behind `API_KEY` |

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

`workspace` / `cwd` / header `X-Workspace` (or `X-Cursor-Cwd`) is **context for the model** (path on *your* machine). It does not upload that directory and does not inject `AGENTS.md`.

### What is mapped

| Request | Behavior |
|---|---|
| `messages[].role` `system` / `user` / `assistant` / `tool` / `function` / `developer` | `developer` → `system`. InferenceService has a real SYSTEM role. |
| `messages[].content` string or array | `text` / `input_text` / `output_text`. |
| `image_url` / `input_image` | Last user message, `data:` URLs only, uploaded as attachments. |
| `file` / `input_file` | Same turn, `data:` documents. **Experimental** — see [limitations](./limitations.md). |
| `tools` + `tool_choice` + `parallel_tool_calls` | OpenAI functions. `none` refuses tools. Legacy `functions` / `function_call` accepted. |
| `stream` | SSE. Same completion `id` for the turn. |
| `stream_options.include_usage` | Extra usage-only chunk after finish. Usage also rides the finish chunk. |
| `max_tokens` / `max_completion_tokens` / `stop` | Enforced on the way out (`finish_reason: length` when truncated). Also sent on Inference `modelConfig` when possible. |
| `temperature` / `top_p` | Forwarded on Inference `modelConfig`. |
| `reasoning_effort` / `reasoning.effort` / `thinking.effort` | Depth. With `MODEL_PARAMETERS=on`, mapped to a catalog variant slug. |
| `response_format` `json_object` / `json_schema` | Prompt-enforced, not a server-side grammar. |
| `conversation_id` / header `X-Conversation-Id` | Resume a **live** in-memory session (~10 minutes) when the official SDK path can `submit` tool results. InferenceService re-POSTs history instead. |

Ignored sampling / storage knobs appear on the response as `cursor_ignored_params` (e.g. `seed`, `logprobs`, `store`).

Non-stream success is a normal `chat.completion` object. Thinking is `choices[0].message.reasoning_content` (and `reasoning`). If the upstream only sent thinking, that text is **promoted** into `content` so the caller is not silent.

### Streaming

`Content-Type: text/event-stream`. Chat frames are `object: "chat.completion.chunk"`.

- `textDelta` → `delta.content`
- thinking → `delta.reasoning_content` and `delta.reasoning`
- tools → `delta.tool_calls`
- finish → `finish_reason` `stop` | `length` | `tool_calls`, then `data: [DONE]`

**Errors after the stream has started** are a **top-level** frame, then `[DONE]`:

```text
data: {"error":{"message":"…","type":"permission_error","code":"unsupported_region","cursor_error":"ERROR_UNSUPPORTED_REGION"}}

data: [DONE]
```

They are **not** written into `delta.content` with `finish_reason: "stop"`. OpenAI SDKs only throw when they see a top-level `error` key; the old fake-200 path made agents treat the error as model prose and made relays bill a success.

If the failure happens **before** the first SSE byte, the HTTP status is the real status (401 / 403 / 429 / 503 / …), not 200.

### Tools (`TOOL_MODE=client`, default)

Round 1 may end with `finish_reason: "tool_calls"`. Execute locally, then POST the **full** history (standard OpenAI). You do not need `conversation_id` on InferenceService.

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

See [examples/tool-loop.sh](../examples/tool-loop.sh). `TOOL_MODE=workspace` runs builtins inside this process (debug only). `TOOL_MODE=none` rejects tools.

Names that collide with Cursor builtins (`Read`, `WebSearch`, …) are renamed on the wire and mapped back.

## Completions (legacy)

```http
POST /v1/completions
```

`prompt` is wrapped as a user message. Streaming uses `object: "text_completion"` and ids `cmpl-…` (not chat chunks). Thinking is omitted on this dialect.

## Responses (subset)

```http
POST /v1/responses
```

Same backend as chat. Translated:

- `input` — string, message items, or loose content parts
- `instructions` → system
- `max_output_tokens` → `max_tokens`
- `reasoning.effort` → `reasoning_effort`
- `text.format` → `response_format`
- flat `{ "type": "function", "name", "parameters" }` tools
- `function_call` / `function_call_output` items replay an agent loop
- `previous_response_id` → live conversation id only

Non-stream body is a Responses `response` object with `store: false`.

Streaming is a real Responses event stream (monotonic `sequence_number`, **no `[DONE]`**):

`response.created` → `response.in_progress` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta` × N → `*.done` → `response.completed` (or `response.incomplete` on `max_tokens`).

Thinking uses `response.reasoning_summary_text.delta`. Tool arguments arrive as one `response.function_call_arguments.delta` (Cursor does not stream args token-by-token).

A stream failure emits `response.failed` and a top-level `error` event — not a completed response with error text in the output.

### 501 surfaces

| Request | Result |
|---|---|
| `GET /v1/responses/{id}` | 501 `not_implemented` |
| `DELETE /v1/responses/{id}` | 501 `not_implemented` |
| `"background": true` | 501 |
| hosted tools `web_search` / `file_search` / `computer_use` / `code_interpreter` | 501 |
| `POST /v1/embeddings` | 501 |
| `POST /v1/images/generations` or `/edits` | 501 |
| `POST /v1/audio/speech`, `/transcriptions`, `/translations` | 501 |
| `POST /v1/moderations` | 501 |

`n > 1` is **400** `unsupported_parameter`, not 501.

## Models

```http
GET /v1/models
GET /v1/models/{id}
```

Union of per-credential catalogs, de-duplicated. Official ids are prefixed `api-`. Extra fields (`context_window`, `supports_images`, `supports_thinking`, `display_name`, `aliases`) are non-standard; OpenAI SDKs ignore them.

**This list is not a plan entitlement.** Expect `plan_restricted`, `unsupported_region`, and rate limits at **call** time. See [limitations](./limitations.md).

Unknown `{id}` → **404** `model_not_found`. Local aliases (e.g. `gpt-4o` → `composer-2`) resolve to the model that will actually run.

Default when `model` is omitted: `kimi-k3` (`DEFAULT_MODEL`).

## Health

### `GET /health` (public)

No `API_KEY`. Load balancers should use this.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "tokens": { "total": 2, "healthy": 2 }
}
```

`status` is `ok` when `tokens.healthy > 0`, else `degraded`. No account names, no usage URLs, no tool settings.

### `GET /health/detail` (authenticated)

Same auth as `/v1/*`. Operator internals: default model, client type/version, tool mode, timeouts, experimental flags, allowlists, sand usage (dashboard URLs stripped). **Do not expose this route without a key.**

## Error JSON

Non-stream failures use a real HTTP status and:

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

`error.code` is a **string**. Debug fields are optional. **Account names and emails are not included.** Dollar amounts in Cursor copy are redacted.

### Taxonomy

| HTTP | `type` | `code` | When |
|---|---|---|---|
| 400 | `invalid_request_error` | `content_filter` | Provider content policy |
| 400 | `invalid_request_error` | `model_not_found` | Bad slug / not in pool |
| 400 | `invalid_request_error` | `context_length_exceeded` | Prompt too large |
| 400 | `invalid_request_error` | `output_token_limit` | Output cap |
| 400 | `invalid_request_error` | `invalid_request` / `unsupported_parameter` | Validation |
| 401 | `authentication_error` | `invalid_api_key` | Converter key or Cursor JWT/`crsr_` rejected |
| 403 | `permission_error` | `unsupported_region` | Geo / provider region block (common for Anthropic from CN) |
| 403 | `permission_error` | `plan_restricted` | Plan cannot run that named model |
| 403 | `permission_error` | `model_blocked` | Dashboard gate |
| 403 | `permission_error` | `permission_denied` | Other 403 |
| 429 | `rate_limit_error` | `rate_limit_exceeded` | Shared usage / `resource_exhausted` |
| 429 | `rate_limit_error` | `model_quota_exhausted` | That model’s quota on that credential |
| 429 | `rate_limit_error` | `pro_rate_limit` | Per-model plan rate limit |
| 499 | `api_error` | `client_closed_request` | Caller aborted |
| 501 | `invalid_request_error` | `not_implemented` | Surfaces above |
| 502 | `api_error` | `upstream_error` | Unclassified Cursor failure |
| 503 | `api_error` | `overloaded` | Provider overloaded |
| 503 | `server_error` | `pool_exhausted` | No healthy sand JWT or `crsr_` of the required kind |

`429` does **not** bench the credential (shared usage). `unsupported_region` does not fail over to another account (the other JWT is usually the same region). `plan_restricted` **may** fail over to another sand JWT. If none remain, you get **503** `pool_exhausted`, not a fake completed chat.

`Retry-After` is sent on `429` only when `TOKEN_RATE_LIMIT_COOLDOWN_MS > 0`.
