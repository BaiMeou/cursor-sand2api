# Changelog

**English** | [中文](./CHANGELOG.zh-CN.md)

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-03

First public documentation release of the unofficial OpenAI-compatible converter. Not affiliated with Cursor. **AGPL-3.0-or-later** from this tag.

### Added

- **Sand chat default path is `aiserver.v1.InferenceService/Stream`.** `agent.v1.AgentService/Run` rejects sand JWTs (`Sand traffic is not supported`) and is no longer the documented sand route.
- **Official `crsr_` pool** via `@cursor/sdk` (`Agent.create` + `send`). Public ids use the `api-` prefix. Cursor’s official REST still has no `/v1/chat/completions`.
- **`POST /v1/responses`** stateless subset (items, streaming event types, function-call replay). `store` / retrieval / deletion / `background` / hosted tools are **501**, not fabricated objects.
- **Error taxonomy** with real HTTP statuses and string `error.code` (`unsupported_region`, `plan_restricted`, `rate_limit_exceeded`, …). Streaming uses a **top-level `error` frame** (Responses: `error` event). Failures are never a fake `200` with the message stuffed into `delta.content`.
- **Health split:** public `GET /health` is `{ status, version, tokens: { total, healthy } }` only. `GET /health/detail` is behind `API_KEY` and carries operator internals.
- **Bind / `API_KEY` guard:** process **exits** if `HOST` is not loopback and `API_KEY` is empty.
- **`503` `pool_exhausted`** when no healthy credential of the required kind remains.
- **`PREFER_GROK_BOT_PLAN`** (default **off**). Named-model routing does not silently prefer a Grok Bot Plan account. Grok Bot `sendPrompt` is not a Claude path and is not implemented.
- **Public docs rewrite:** English README plus `docs/*`, `SECURITY.md`, `CONTRIBUTING.md`, `.env.example`, and `examples/`. Private inventory, hostnames, and operator notes removed from the landing page.
- **Bilingual docs:** English plus 中文 (`README.zh-CN.md`, `docs/zh/`).

### Changed

- Default `DEFAULT_MODEL` is `kimi-k3` (family). Cooldown env defaults are `0` (`TOKEN_COOLDOWN_MS`, `TOKEN_AUTH_COOLDOWN_MS`, `TOKEN_RATE_LIMIT_COOLDOWN_MS`).
- `WEB_UI` defaults **on** only for loopback; off when binding a non-loopback address unless `WEB_UI=on`.
- `GET /v1/models` documented as a **catalog**, not a plan entitlement. Call-time `plan_restricted` / `unsupported_region` / rate limits are expected (including Anthropic geo `403`s).
- LICENSE is GNU Affero GPL v3. `package.json` `license` is `AGPL-3.0-or-later`. A modified version offered as a service must provide corresponding source. The license does not authorize violating Cursor’s terms.

### Security

- Empty `API_KEY` is localhost-only. CORS does not default to `*` on a public bind. `token.json` remains gitignored. Public health no longer carries usage dashboards or account lists.

## [0.7.0] — 2026-08-30

Historical **0.7.0 / rc** line (private tree, not a separate public tag). Kept here so 1.0.0 is not a mysterious jump.

That generation was already an OpenAI Chat Completions converter over **your** Cursor credentials: `TOOL_MODE=client` by default, local tool loop, image `data:` attachments, experimental documents, prompt-enforced JSON mode, `max_tokens` / `stop` enforced on the way out, and the start of honest (non-200) errors.

Sand chat in that line still targeted **`AgentService/Run`** with `x-cursor-client-type: sand`. Official `crsr_` keys, InferenceService as the sand default, the health split, the listen guard, and this public documentation set arrived on the way to 1.0.0.
