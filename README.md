# cursor-sand2api

**English** | [中文](./README.zh-CN.md)

Docs: English in `README.md` / `docs/` · 中文在 [`README.zh-CN.md`](./README.zh-CN.md) / [`docs/zh/`](./docs/zh/).

Unofficial OpenAI-compatible HTTP converter for **your** Cursor credentials.

- **Sand IDE JWT** → Cursor ConnectRPC. Chat default is `aiserver.v1.InferenceService/Stream`.
- **Official User API Keys** (`crsr_…`) → [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) (`Agent.create` + `send`).

Version **1.0.0**. [AGPL-3.0-or-later](./LICENSE). **Not affiliated with Cursor** or Anysphere. This repository is `private: true` on purpose — it is **not** an npm package.

`agent.v1.AgentService/Run` **rejects** sand JWTs (`Sand traffic is not supported`). Do not configure this project as if sand chat still went through AgentService. Grok Bot desktop `sendPrompt` has **no model field** and cannot select Claude; that gateway is not implemented here.

## Disclaimer

This is a reverse-engineered adapter over **your** Cursor login and quota. It can break when Cursor changes a header, RPC, or plan rule. You are responsible for Cursor’s terms, spend, and credential hygiene.

Read **[docs/disclaimer.md](docs/disclaimer.md)** before you run it.

## What it is

A small Node HTTP server (`HOST=127.0.0.1`, `PORT=13000` by default) that accepts a subset of OpenAI’s Chat Completions / Completions / Responses shapes, talks to Cursor with **your** `token.json`, and returns OpenAI-shaped JSON or SSE.

It is not Cursor’s official API, not a multi-tenant proxy, and not a full OpenAI clone. `GET /v1/models` is a **catalog**, not a plan entitlement.

## Features

- Dual pool in one file: sand JWT + official `crsr_` keys, round-robin, failover where it is safe
- Sand chat on **InferenceService/Stream**; official ids prefixed `api-`
- Streaming with a **top-level `error` frame** (no fake `200` + error-as-prose)
- Client-side tool loop (`TOOL_MODE=client`): you execute `tool_calls` locally
- Stateless Responses subset; store / retrieval / hosted tools are honest **501**
- Bind guard: process **exits** if you listen off loopback without `API_KEY`
- Public `/health` vs authenticated `/health/detail`
- Optional zh-CN web console on loopback only
- `npm run token` imports a sand JWT from a local Cursor install (Node 22.5+)

## Requirements

- **Node.js 18.18+** to run the server and `npm test`
- **Node.js 22.5+** for `npm run token` (`node:sqlite`)
- A Cursor account you are allowed to use, and credentials you own
- `token.json` on disk (never committed)

## Quick start

```bash
git clone https://github.com/BaiMeou/cursor-sand2api.git
cd cursor-sand2api
npm install
npm run token          # sand JWT from the local Cursor app → token.json
# or: cp token.json.example token.json  and fill it yourself
HOST=127.0.0.1 PORT=13000 API_KEY=changeme npm start
```

```bash
curl -sS http://127.0.0.1:13000/v1/chat/completions \
  -H "Authorization: Bearer changeme" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kimi-k3",
    "workspace": "/path/to/your/project",
    "messages": [{"role":"user","content":"Reply with exactly: pong"}]
  }'
```

Scripts: [examples/chat-completions.sh](examples/chat-completions.sh), [examples/tool-loop.sh](examples/tool-loop.sh).

`GET http://127.0.0.1:13000/health` is public and only returns `{ status, version, tokens: { total, healthy } }`.

## Credentials

| `kind` | You provide | Upstream |
|---|---|---|
| `sand` | `accessToken` + machine ids | InferenceService/Stream (default) |
| `api` | `apiKey` (`crsr_…`) | Official `@cursor/sdk` |

`npm run token` flags: `--print`, `--force`, `--name`, `--out`, `--db`. Full schema and OS paths: **[docs/credentials.md](docs/credentials.md)**.

**Never commit `token.json`.**

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Non-loopback requires `API_KEY` or the process exits |
| `PORT` | `13000` | |
| `API_KEY` | *(empty)* | Required off loopback. Bearer token for `/v1/*` |
| `WEB_UI` | on **only** on loopback | Off on a public bind unless `WEB_UI=on` — do not do that |
| `DEFAULT_MODEL` | `kimi-k3` | |
| `TOOL_MODE` | `client` | `workspace` / `none` also exist |
| `TOKEN_*_COOLDOWN_MS` | `0` | Do not bench JWTs for shared `429`s |
| `PREFER_GROK_BOT_PLAN` | `false` | Do not silently hop to a Grok Bot Plan account |

Full table (including `CURSOR_*`, timeouts, tools, history flags): **[docs/configuration.md](docs/configuration.md)** and [.env.example](./.env.example).

## API usage

```text
POST /v1/chat/completions
POST /v1/completions
POST /v1/responses          # stateless subset
GET  /v1/models             # catalog, not entitlement
GET  /v1/models/{id}
GET  /health                # public
GET  /health/detail         # API_KEY
```

Expect `plan_restricted`, `unsupported_region` (Anthropic from CN / other geo), and rate limits **at call time** even if the model is listed. Errors are JSON `{ message, type, code }` plus optional `cursor_*` debug — **no account names**. Streams use a top-level `error` frame.

**501** (not faked): embeddings, images, audio, moderations, Responses store/get/delete, `background`, hosted tools.

Details: **[docs/api.md](docs/api.md)**.

## Web console

On loopback, open `http://127.0.0.1:13000`. zh-CN static UI, state in `localStorage` key `sand2api.state.v1`, badge from `/health`, operator JSON from `/health/detail`. Set `WEB_UI=off` on any shared host. **Do not expose the UI on `0.0.0.0`.**

**[docs/web-console.md](docs/web-console.md)**

## Deployment

Bind `127.0.0.1`, set `API_KEY`, set `WEB_UI=off`, put TLS on a reverse proxy. Generic systemd + Caddy/nginx sketches: **[docs/deployment.md](docs/deployment.md)**.

## Limitations

Not a full OpenAI API. Listing ≠ entitlement. Plan buckets (sand weekly / Other Models / official API / SuperGrok) do not share leftover quota. Documents and `CONVERSATION_HISTORY` are experimental. Nothing is stored (`store: false`). This process does not inject your project `AGENTS.md`.

**[docs/limitations.md](docs/limitations.md)**

Protocol internals: [docs/advanced/reverse-engineering.md](docs/advanced/reverse-engineering.md) · [system-context.md](docs/advanced/system-context.md) · [protocol-lab-notes.md](docs/advanced/protocol-lab-notes.md)

## Development

```bash
npm test          # node --test test/*.test.js
```

See **[CONTRIBUTING.md](CONTRIBUTING.md)** and **[SECURITY.md](SECURITY.md)**. Do not open PRs that include `token.json` or live secrets.

## License

[GNU Affero General Public License v3.0 or later](./LICENSE) — Copyright (c) 2026 BaiMeou and cursor-sand2api contributors.

You may run, change, and share this converter. If you run a modified version as a network service, you must offer the corresponding source to its users (AGPL §13). The license does **not** grant permission to violate Cursor’s terms.

Cursor is a trademark of its owners. This project is unofficial.
