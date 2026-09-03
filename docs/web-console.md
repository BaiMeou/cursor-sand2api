# Web console

**English** | [中文](./zh/web-console.md)

The process can serve a small chat UI from `public/` at `/`. There is **no build step**, no CDN, and no frontend npm dependency. The UI language is **zh-CN** (`<html lang="zh-CN">`). Copy and buttons are Chinese; this document is English.

The page talks only to **this** converter: `/v1/models`, `/v1/chat/completions`, `/health`, and `/health/detail`. It does not know about Cursor RPCs or `token.json`.

## When it is served

`WEB_UI` is resolved against `HOST` (see [configuration](./configuration.md)):

| Bind | Unset `WEB_UI` | Explicit |
|---|---|---|
| `127.0.0.1` / `::1` / `localhost` | **on** | `WEB_UI=off` disables it |
| Any other address | **off** | `WEB_UI=on` forces it **on** — do not do this on a public IP |

With the UI off, `/` is 404. `/v1/*` is unchanged.

**Do not expose this console on `0.0.0.0`.** It is unauthenticated static files. Anyone who can load the page and who can guess or steal `API_KEY` (or who hits a loopback-empty-key setup through a tunnel) spends **your** Cursor quota. On a server, set `WEB_UI=off` and run a local copy if you want the UI.

## localStorage

All state lives in the browser under:

```text
sand2api.state.v1
```

That object holds the converter API key, base URL override, theme, model, parameter panel, and conversation list (including staged attachments). Clearing site data logs you out of the console; it does not revoke Cursor credentials.

There is no server-side session for the UI.

## Settings

On first open, fill **API Key** with the same value as process `API_KEY` (for example `changeme`). Calls send `Authorization: Bearer …`. If the server has an empty key (loopback only), the field can stay empty.

Optional base URL defaults to the page origin so `http://127.0.0.1:13000` just works.

## Health

The sidebar badge calls **`GET /health`** (public): `status`, `version`, and `tokens.total` / `tokens.healthy`. That is enough to show “ok · 2/2”.

The settings panel’s raw JSON uses **`GET /health/detail`** when an API key is configured, so operators can see tool mode, timeouts, and stripped usage without putting those fields on the public probe. Without a key, the panel falls back to the public `/health` body.

Do not screenshot `/health/detail` into a GitHub issue.

## Features

- Streaming chat; thinking folded as “思考过程”; stop button
- Model picker from `/v1/models` (context window, images, thinking). Names missing from the catalog are marked but still selectable — listing ≠ entitlement
- Image and document attachments (click / drag / paste) on the same path as the HTTP API
- Multiple conversations persisted in `sand2api.state.v1`
- System prompt, `max_tokens`, temperature, reasoning effort, JSON mode, stop sequences
- Per-turn usage and light/dark theme

`npm run ui` is an optional headed-less smoke (system Chrome/Edge via CDP, no Playwright). It spends quota if you point it at a live server.

## Files

```text
public/index.html
public/app.css
public/app.js
public/markdown.js
```

Edit and refresh. No bundler.
