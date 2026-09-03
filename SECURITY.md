# Security

**English** | [中文](./SECURITY.zh-CN.md)

cursor-sand2api holds **your** Cursor login (sand IDE JWT) and/or **your** official Cursor User API Keys (`crsr_…`). Treat the process, `token.json`, and any reverse proxy in front of it as a credential store.

This document is the threat model for a default install. Read [configuration](docs/configuration.md) and [deployment](docs/deployment.md) before binding anything other than loopback.

## Empty `API_KEY`

Default: `API_KEY` is empty and `HOST=127.0.0.1`.

- On **loopback** (`127.0.0.1`, `::1`, `localhost`), an empty key means **no `Authorization` check**. Any local process can call `/v1/*`. That is intentional for a single-user workstation. Set `API_KEY` if other users or sandboxed apps share the machine.
- On a **non-loopback** bind (`0.0.0.0`, a LAN address, a public address), an empty `API_KEY` is refused: the process **exits** with `Set API_KEY before binding to a non-loopback address`. Do not patch that guard out.

`API_KEY` is a shared secret for **this converter**, not a Cursor token. It never replaces `token.json`. Send it as `Authorization: Bearer <API_KEY>`.

## Web console (`WEB_UI`)

The files under `public/` are **unauthenticated static assets**. They store the converter API key in the browser (`localStorage` key `sand2api.state.v1`) and then call the same `/v1/*` routes as any other client.

- Default: UI is **on** only when `HOST` is loopback. Binding a non-loopback address turns the UI **off** unless you set `WEB_UI=on` explicitly.
- Do **not** serve the console on `0.0.0.0` or a public interface. Prefer `WEB_UI=off` behind a reverse proxy and use a local `127.0.0.1` process if you want the UI.
- The page itself is not a secret. The danger is a reachable UI plus a stolen or empty `API_KEY`, which becomes a remote Cursor spend button.

## `token.json`

- Contains sand JWTs (`accessToken` + machine ids) and/or `crsr_` keys.
- **Never commit it.** `.gitignore` already excludes `token.json`, `token-*.json`, `token-disabled.json`, and `.env`.
- Write it mode `0600` (`npm run token` does). Keep backups offline.
- A stolen sand JWT is a stolen Cursor IDE session. A stolen `crsr_` key is a stolen official API key. Rotate both in the Cursor dashboard / by signing the IDE out and back in.
- The importer (`npm run token`) prints account label and expiry only. It does not print the JWT.

## `/health` versus `/health/detail`

| Route | Auth | Body |
|---|---|---|
| `GET /health` | **Public** | `{ status, version, tokens: { total, healthy } }` only |
| `GET /health/detail` | Same as `/v1/*` (`API_KEY` when set) | Operator internals (tool mode, timeouts, allowlists, sand usage). Usage blobs are stripped of dashboard URLs and similar PII. |

Do not expose `/health/detail` without a key. Do not put account emails, JWT prefixes, or Cursor dashboard links on the public health route. Load balancers should probe `/health`.

## CORS

`CORS_ORIGIN` controls the `cors` middleware:

- Unset on loopback: reflect the request origin (local web console works).
- Unset on a non-loopback bind: do **not** send `Access-Control-Allow-Origin: *`.
- Set a comma-separated allow-list of origins you actually use.
- `CORS_ORIGIN=*` makes any website able to call the converter **from a browser** if the victim’s `API_KEY` is empty or leaked into JS. Do not use `*` on a shared or public bind.

## What the API must not leak

Error JSON is `message`, `type`, `code`, plus optional `cursor_*` debug (`cursor_error`, `cursor_title`, `cursor_detail`), `hint`, `action_required`, `retryable`, `model`, `requested_model`, `conversation_id`. **Account names, emails, and raw tokens are not part of the public error object.** Do not log those to a shared request log either.

Streaming failures are a **top-level** `error` frame (see [api.md](docs/api.md)), not a fake `200` with the error stuffed into `delta.content`.

## Historical private-tree notes

Older private commits documented an operator deploy (internal hostnames, a sample converter `API_KEY`). Those files are **not** in the 1.0.0 tree. If you cloned this repository before the public `v1.0.0` tag, treat any key or address from that history as compromised and rotate it. The public release is meant to be consumed from tag `v1.0.0` (or a history-scrubbed default branch), not from the pre-1.0.0 private mainline.

## Reporting a vulnerability

Open a GitHub issue or security advisory at [BaiMeou/cursor-sand2api](https://github.com/BaiMeou/cursor-sand2api).

**Never paste** `accessToken`, `crsr_` keys, `token.json`, `.env`, checksum headers, or full `Authorization` lines into an issue, pull request, screenshot, or CI log. Redact to “sand JWT” / “crsr_ key” and describe the behavior.

If you believe Cursor itself is involved (account takeover, upstream injection), report that to Cursor, not only here.
