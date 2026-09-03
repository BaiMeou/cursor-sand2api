# Limitations

**English** | [中文](./zh/limitations.md)

This is a **converter**, not OpenAI, not Cursor’s official HTTP API, and not a full agent runtime. Read this before you wire a gateway or an SDK and assume parity.

## Not a full OpenAI API

Implemented (see [api.md](./api.md)):

- `POST /v1/chat/completions`
- `POST /v1/completions` (legacy text; streaming uses `text_completion` frames, ids `cmpl-…`)
- `POST /v1/responses` — **stateless subset** only
- `GET /v1/models` and `GET /v1/models/{id}`

Honest **501** (not a fabricated success):

- `GET` / `DELETE /v1/responses/{id}` — nothing is stored
- `background: true`
- hosted Responses tools: `web_search`, `file_search`, `computer_use`, `code_interpreter`
- `/v1/embeddings`, `/v1/images/*`, `/v1/audio/*`, `/v1/moderations`

Also not implemented (validation or ignore, not a silent success story):

- `n > 1`
- `store`, assistants, files, fine-tuning, batches
- `logprobs` / `logit_bias` / `seed` sampling (listed on the response as `cursor_ignored_params` when sent)
- remote `https://` image or file URLs (only `data:` URLs are uploaded)
- audio modalities

`temperature` and `top_p` are forwarded on **InferenceService** `modelConfig` when present. Other sampling knobs are not.

## Listing is not entitlement

`GET /v1/models` is a **catalog**: the union of names each sand JWT and each `crsr_` key can *see*, plus metadata (context window, images, thinking). It is **not** a promise that the next completion will run.

At call time Cursor may still return:

| `error.code` | Typical cause |
|---|---|
| `plan_restricted` | This membership cannot run that **named** model (spend-limit / “upgrade or set a Spend Limit” / free plans Auto-only). |
| `unsupported_region` | Provider blocked for the account or the converter’s egress region. **Anthropic models often 403 from CN and other geo-restricted paths.** |
| `rate_limit_exceeded` / `model_quota_exhausted` / `pro_rate_limit` | Weekly pool, official API quota, or per-model plan rate limit. |
| `model_not_found` / `model_blocked` | Slug invalid, or the model is gated until you accept its data policy. |
| `pool_exhausted` | This process has no healthy credential of the required kind (503). |

Switch model, switch pool (`kimi-k3` vs `api-kimi-k3`), or wait. Do not treat an empty `200` catalog miss as “the model exists.” `GET /v1/models/{id}` returns **404** for unknown ids (after local aliases such as `gpt-4o` → `composer-2`).

## Plan buckets are not one pile

The same human can hold several Cursor buckets that do **not** share remaining tokens:

- **Sand / Bot weekly pool** — default `x-cursor-client-type: sand` on InferenceService.
- **IDE “Other Models”** — `ide` / missing type header, historically `AgentService/Run`.
- **Official User API Key** — `crsr_` / `api-*` ids, `@cursor/sdk`, separate “API model usage” quota.
- **SuperGrok / SuperGrok Heavy** — a Grok-oriented weekly label. Named Claude/Kimi on that membership still often `403` `plan_restricted`. A **Grok Bot Plan** label is the sand bucket that has been observed to run those named slugs. `PREFER_GROK_BOT_PLAN` defaults **off** so the converter does not quietly hop accounts.

Grok Bot desktop `sendPrompt` has **no model picker**. It is not a Claude path and is not implemented here.

## Documents are experimental

Inline `data:` **images** on the last user message are uploaded as real Inference/Agent attachments (size limits: 5 MB each, 15 MB per turn). End-to-end checks have seen models describe solid-color PNGs correctly. **kimi\* does not support images** in the catalog (`supports_images=false`); pick a vision-capable id.

Inline `data:` **documents** (`file` / `input_file`, 10 MB each, 20 MB per turn) use the sibling `selectedDocuments` field. Encoding is covered by unit tests. **There is no end-to-end guarantee** that Cursor feeds those bytes to the model the way images are fed. `file_id` is not supported (no store).

History attachments are **not** re-uploaded; they become “omitted” placeholders in the prompt.

## `CONVERSATION_HISTORY` is experimental

`CONVERSATION_HISTORY=true` sends Agent-path history as KV blobs instead of flattened user text. That combination has **not** been proven on `sand` + `connect+json`. A missed `kvClientMessage` handshake hangs the stream until `IDLE_TIMEOUT`.

Default sand chat is **InferenceService/Stream**: unary server-streaming. Tool results cannot be written on the same HTTP/2 stream; the next HTTP request re-POSTs the full OpenAI message list (including `role: tool`). Official `crsr_` runs can continue the same SDK run when `tool_call_id`s still map to a live session (about 10 minutes).

## No store

The converter is stateless across restarts aside from `token.json` / `token-disabled.json` and in-memory sessions.

- Responses `store` is always **false**.
- `GET` / `DELETE /v1/responses/{id}` → **501**.
- `previous_response_id` is treated as a conversation id for a **still-live** in-memory session only.

Do not build clients that expect to fetch last Tuesday’s response by id.

## Sand2api does not inject your project rules

Cursor IDE Agent injects `<user_info>`, `<rules>`, `AGENTS.md`, git status, and MCP instructions. This process does **not**. It will not read `/path/to/your/project/AGENTS.md` off disk and stuff it into the model. Put instructions in `messages[].role=system`, attach files, or run Cursor itself. Details: [advanced/system-context.md](./advanced/system-context.md).

## Other sharp edges

- Unofficial; Cursor can break the protocol at any time ([disclaimer](./disclaimer.md)).
- Sand JWT ≠ official `crsr_` ≠ Grok Bot gateway token.
- `usage` on anonymous-looking Cursor paths can be sparse; do not require exact token accounting.
- Default model `kimi-k3` is a **family**. Upstream sand often wants a variant slug (`kimi-k3-max`, …). The converter maps; a bare `kimi-k3` sent raw to older Agent RPCs was rejected.
- Tool names that collide with Cursor builtins (`Read`, `WebSearch`, …) are renamed on the wire and mapped back.
- `TOOL_MODE=workspace` executes tools **inside this process**. That is local debug, not a remote runner you should expose.
