# Configuration

**English** | [中文](./zh/configuration.md)

All settings are environment variables. There is no config file besides `token.json` (see [credentials](./credentials.md)). Copy [.env.example](../.env.example) and export the file yourself, or pass vars on the command line.

Boolean vars that go through the shared parser accept `1` / `true` / `yes` / `on` (case-insensitive). `ENABLE_SHELL` is stricter: only `1` or `true`. `ENABLE_FETCH` is on unless set to `0`.

Do not invent names that are not in this table. Do not bind a public address without `API_KEY`. Do not turn `WEB_UI=on` on `0.0.0.0`.

## Process and HTTP

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Listen address. Loopback only unless you set `API_KEY`. |
| `PORT` | `13000` | Listen port. |
| `API_KEY` | *(empty)* | Shared secret for `/v1/*` and `/health/detail`. Empty is allowed **only** on loopback; a non-loopback bind **exits** if this is empty. Send `Authorization: Bearer …`. |
| `WEB_UI` | loopback: **on**; non-loopback: **off** | Serve `public/` at `/`. Explicit `on` / `off` / `1` / `0` / `true` / `false` / `yes` / `no`. Unset follows the bind: UI on for `127.0.0.1` / `::1` / `localhost`, off otherwise. **Do not enable this on a public bind.** |
| `CORS_ORIGIN` | loopback: reflect request origin; non-loopback: no `*` | `*` to allow any browser origin (dangerous with an empty or leaked key). Comma-separated list for an allow-list. Unset on loopback lets the local console work. |
| `TOKEN_FILE` | `./token.json` | Credential pool path. |
| `MAX_BODY_SIZE` | `64mb` | Express JSON limit. A full turn can be 15 MB of images + 20 MB of documents, plus base64. |

## Cursor client (sand JWT)

| Variable | Default | Meaning |
|---|---|---|
| `CURSOR_BASE_URL` | `https://api2.cursor.sh` | ConnectRPC host. |
| `CURSOR_CLIENT_VERSION` | `3.17.21` | `x-cursor-client-version`. Keep near the Cursor app you imported from. `0.30.0` is also accepted as sand. |
| `CURSOR_CLIENT_TYPE` | `sand` | `x-cursor-client-type`. `sand` is the default chat path (`InferenceService/Stream`, sand / Bot weekly pool). `ide` (or empty in older clients) is treated as IDE / Other Models and uses `AgentService/Run`. |
| `SAND_BOX_NAMESPACE` | `prod` | `x-sand-box-namespace` when type is `sand`. Official Bot sends `prod`. |
| `CURSOR_USER_AGENT` | `connect-es/1.6.1` | HTTP `user-agent`. |
| `CURSOR_ACCEPT_GZIP` | off | If on, send `connect-accept-encoding: gzip`. Frames may then arrive flag `0x01`. |
| `CURSOR_GHOST_MODE` | *(empty)* | If set to `true` or `false`, send `x-ghost-mode`. |
| `CURSOR_ALLOWED_NATIVE_TOOLS` | *(empty → no header)* | Comma-separated names for `x-cursor-agent-allowed-tools`. Empty or `*` omits the header (Cursor’s full native set). Example: `mcp_tool_call,get_mcp_tools_tool_call`. This is the only reliable way to stop the Agent path from advertising dozens of builtins; InferenceService does not need it for a tools-empty turn. |
| `DEFAULT_MODEL` | `kimi-k3` | Used when the request omits `model`. Family name; sand still talks a variant slug upstream when required. |

## Timeouts

| Variable | Default | Meaning |
|---|---|---|
| `REQUEST_TIMEOUT` | `300000` | Overall request budget (ms). Tool loops can run longer than a single model call. |
| `IDLE_TIMEOUT` | `120000` | No inbound frame at all (including heartbeats) → socket is dead. |
| `OUTPUT_TIMEOUT` | `240000` | Frames keep arriving but none is model output → the turn is wedged (e.g. waiting for an exec handshake). Reset only by text/thinking deltas. Both clocks yield while the caller is expected to run tools. |

## Token pool cooldowns

Defaults are **off**. A `429` is shared Cursor usage, not a dead credential; benching the JWT only hides a still-usable account.

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_COOLDOWN_MS` | `0` | After a generic failure, pause this account (ms). `0` = do not pause. |
| `TOKEN_AUTH_COOLDOWN_MS` | `0` | Extra pause after `401` / most `403`. `0` = do not pause. |
| `TOKEN_RATE_LIMIT_COOLDOWN_MS` | `0` | If `> 0`, set HTTP `Retry-After` on `429`. The account is **still not** benched for shared usage. |

When every matching credential is missing, expired, or cooling down, the converter returns **503** `pool_exhausted` instead of a fake `200`.

## Models and debug

| Variable | Default | Meaning |
|---|---|---|
| `MODEL_CACHE_TTL_MS` | `900000` | How long `/v1/models` and per-account catalogs stay cached. |
| `MODEL_ERROR_CACHE_TTL_MS` | `30000` | Cache TTL after a catalog fetch fails. |
| `MODEL_PARAMETERS` | off | Resolve the caller’s name against the account catalog and turn `reasoning_effort` / `reasoning.effort` / `thinking.effort` (and kimi `-low`/`-high`/`-max` suffixes) into the slug Cursor actually runs. Off: send the mapped name as-is. |
| `DEBUG_TOOL_TRACE` | off | If on, successful responses may include `tool_trace` (exec names, paths, commands). Leave off in any shared process. |
| `DEBUG_PROMPT` | off | Log the first ~1200 characters of the prompt actually sent. |

## Tools and workspace

| Variable | Default | Meaning |
|---|---|---|
| `TOOL_MODE` | `client` | `client` — return OpenAI `tool_calls`; **you** execute them. `workspace` — this process executes Cursor builtins under `WORKSPACE_DIR` (local debug only). `none` — reject tools. |
| `WORKSPACE_DIR` | `./workspace` | Root for `TOOL_MODE=workspace`. Request `workspace` / `cwd` / header `X-Workspace` is context for the model, not a sandbox escape hatch on the `client` path. |
| `ENABLE_SHELL` | off | `workspace` mode only. Set `1` or `true` to allow `shell`. |
| `ENABLE_FETCH` | on | `workspace` mode only. Set `0` to refuse `web_fetch`. |
| `SHELL_TIMEOUT_MS` | `30000` | `workspace` shell timeout. |
| `DECLARE_MCP_TOOLS` | off | Agent path: declare the caller’s functions as `McpToolDefinition` so the model emits real MCP calls instead of `invoke_client_tool` text. Leave off on Inference unless you know you need it. |
| `CONVERSATION_HISTORY` | off | **Experimental.** Agent path: send history as KV blobs (`conversationState` + sha256 pull) instead of flattening into one user turn. Untested on `sand` + `connect+json`. InferenceService already re-POSTs the message list each turn. |
| `SYSTEM_AS_HISTORY` | on | Agent path: Cursor drops a real `system` role; rewrite it as a user/assistant opening exchange. InferenceService has a real SYSTEM role and does not need this. |
| `CONTINUATION_PROMPT` | `Continue, using the tool results above.` | Agent path: text sent when history ends on a tool result and there is no new user line. |
| `WEB_SEARCH` | off | Allow Cursor to run **its** web search (approval handshake + `agent-tools/` scratch). Spends the account’s quota. Off by default so a stranger’s prompt cannot spend search. |
| `PREFER_GROK_BOT_PLAN` | `false` | If `true`, named-model sand picks prefer credentials whose usage label is a **Grok Bot Plan** (not SuperGrok / SuperGrok Heavy). SuperGrok still `403`s many named Claude/Kimi slugs with spend-limit copy (`plan_restricted`). Default **off**: do not silently jump accounts. |

`PREFER_GROK_BOT_PLAN` is not a Claude switch and does not enable Grok Bot `sendPrompt`.

## Short examples

Loopback, key set (recommended even at home):

```bash
HOST=127.0.0.1 PORT=13000 API_KEY=changeme npm start
```

API only, still loopback:

```bash
HOST=127.0.0.1 WEB_UI=off API_KEY=changeme npm start
```

A reverse proxy on the same machine should keep this process on `127.0.0.1` and set `API_KEY`. See [deployment](./deployment.md).
