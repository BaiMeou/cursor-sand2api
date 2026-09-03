# Protocol lab notes

**English** | [中文](../zh/advanced/protocol-lab-notes.md)

Full write-up: [reverse-engineering.md](./reverse-engineering.md). This page keeps a 2026-08-29 A/B on headers and a short handshake checklist. **Unofficial. May break.**

Transport for the Agent matrix below: HTTP/2 ConnectRPC to `https://api2.cursor.sh/agent.v1.AgentService/Run`, `content-type: application/connect+json`, 5-byte envelopes.

Sand **chat** in 1.0.0 defaults to `https://api2.cursor.sh/aiserver.v1.InferenceService/Stream`. The header effects still matter: `x-cursor-client-type` selects the quota bucket. `AgentService/Run` now **rejects** sand JWTs (`Sand traffic is not supported`).

## Headers that mattered

Official Grok Bot `getSandBackendClientHeaders()`:

```text
x-cursor-client-type: sand
x-cursor-client-version: 0.30.0
x-sand-box-namespace: prod
```

Clients that omit `x-cursor-client-type` are treated as IDE / Other Models.

This converter defaults to type `sand`, version `3.17.21`, namespace `prod`.

## Matrix (prompt: `Reply with exactly: pong`)

Same JWT, `AgentService/Run`, 2026-08-29:

| Variant | type | namespace | version | `kimi-k3-max` | `cursor-grok-4.6-high` |
|---|---|---|---|---|---|
| A | *(none)* | | 3.17.21 | Other Models limit ~0.9s | pong ~2.7s |
| B | `ide` | | 3.17.21 | Other Models limit ~0.9s | pong ~2.8s |
| C | `sand` | | 3.17.21 | **pong ~2.1s** | pong ~2.9s |
| D | `sand` | `prod` | 3.17.21 | **pong ~1.9s** | pong ~2.8s |
| E | `sand` | `prod` | `0.30.0` | **pong ~2.0s** | pong ~2.7s |

Bare `kimi-k3` was rejected (`Model name is not valid`) on both pools. Public id `kimi-k3` is a family; the converter maps to a variant slug before sand Inference.

`x-sand-box-namespace: prod` was **not** required for the Other Models → sand pool swap. Official Bot still sends it.

This is a **pool swap**, not infinite quota. When the sand weekly bucket is empty, calls fail like any other limit.

## Handshake (Agent)

Sand (and often IDE) sends `execServerMessage.requestContextArgs` before tokens. Reply with `execClientMessage.requestContextResult.success` or the stream never `turnEnded`. The first probe hung ~7 minutes here until exec handling existed.

Headless default: refuse shell/read/ls/grep/write; empty diagnostics; answer web-search **approval** queries (deny if `WEB_SEARCH=off`) so the stream cannot stall on an unanswered prompt.

InferenceService/Stream does not use that bi-di exec loop. Tool results are a **new** HTTP request with the OpenAI history.

## Not this protocol

Grok Bot desktop chat is:

1. `aiserver.v1.GrokBotService/EnsureSandBox`
2. `POST {gatewayUrl}/api/sendPrompt` with `{ agentId, prompt, … }` — **no model id**

The model on that path lives in host settings (`agentDefaultModel` / `computerUseModel`). Computer-use default id in the asar was `grok-4.5`. **`sendPrompt` cannot select Claude.** This converter does not implement the Bot gateway.

Official User API Keys (`crsr_`) are a fourth path: `@cursor/sdk`, not Connect `Run` with a sand JWT.
