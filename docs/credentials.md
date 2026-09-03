# Credentials

**English** | [中文](./zh/credentials.md)

cursor-sand2api never logs in to Cursor for you. It only **reuses credentials you already have**: a sand IDE JWT from a local Cursor install, and/or an official User API Key (`crsr_…`) from the Cursor dashboard.

Both kinds live in one JSON file (default `./token.json`). The process **exits on startup** if that file is missing or contains no usable entry. The file is watched and reloaded when it changes.

**Never commit `token.json`.** Copy [token.json.example](../token.json.example). `.gitignore` already excludes `token.json`, `token-*.json`, and `token-disabled.json`.

## Two kinds

| `kind` | Fields | Upstream | Public model ids |
|---|---|---|---|
| `sand` (default) | `accessToken` + `machineId` + optional `macMachineId` | Cursor ConnectRPC. **Chat default is `aiserver.v1.InferenceService/Stream`.** `agent.v1.AgentService/Run` rejects sand JWTs (`Sand traffic is not supported`). | Unprefixed family names (`kimi-k3`, `claude-4.5-sonnet`, …) |
| `api` | `apiKey` starting with `crsr_` | Official [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) (`Agent.create` + `send`). Cursor’s official REST **does not** expose `/v1/chat/completions`; the SDK is the supported official path. | Same names with an `api-` prefix (`api-kimi-k3`, `api-composer-2.5`) |

You can mix both arrays in one file. The converter picks a credential whose **kind** matches the requested id (`api-*` → official pool, otherwise sand) and whose per-account catalog still lists that model.

Grok Bot desktop chat (`GrokBotService/EnsureSandBox` then `{gatewayUrl}/api/sendPrompt`) is **not** wired. `sendPrompt` has **no model field** and cannot select Claude (or any other named model). Do not treat that Bot gateway as a Claude path.

## Schema (`token.json.example`)

```json
{
  "tokens": [
    {
      "name": "sand-ultra",
      "kind": "sand",
      "accessToken": "your-cursor-access-token-here",
      "machineId": "your-machine-id-here",
      "macMachineId": "your-mac-machine-id-here"
    },
    {
      "name": "official-sdk",
      "kind": "api",
      "apiKey": "crsr_your-cursor-user-api-key-here"
    }
  ]
}
```

Rules:

- `name` is a local label for logs. It is **not** returned on public error JSON.
- Sand entries without a real `accessToken` (or still set to the example placeholder) are skipped.
- Official entries are recognized if `kind` is `api` / `official` / `crsr`, or if `apiKey` / `key` starts with `crsr_`.
- A top-level array of objects is also accepted (`[{ ... }, ...]`).
- `TOKEN_FILE` overrides the path (see [configuration](./configuration.md)).

Create official keys at [cursor.com/dashboard/api](https://cursor.com/dashboard/api). Paste only keys you own.

## `npm run token`

Imports a **sand** JWT from a locally installed, signed-in Cursor. Requires **Node 22.5+** (`node:sqlite`). The HTTP server itself runs on Node 18.18+.

```bash
npm run token
```

The script opens Cursor’s `state.vscdb` (if Cursor holds the write lock it copies the db + WAL to a temp file and reads that), reads `cursorAuth/accessToken`, then reads `telemetry.machineId` / `telemetry.macMachineId` from the sibling `storage.json`. It **merges** into `token.json`: existing accounts are kept; the same `name` or same `accessToken` is replaced. The file is written mode `0600`.

It prints the account label, plan string if present, expiry, and a short machine-id prefix. **It does not print the token.**

### Flags

| Flag | Meaning |
|---|---|
| `--print` | Show label / expiry / machine prefix only. Write nothing. |
| `--force` | If the output file exists but is not valid JSON, replace it instead of exiting. |
| `--name <label>` | Store under this `name` (default: cached email, else `cursor-ide`). |
| `--out <path>` | Write that file instead of `./token.json`. |
| `--db <path>` | Use this `state.vscdb` (portable installs, extra profiles). `storage.json` is taken from the same directory. |
| `--help` / `-h` | Usage. |

Examples:

```bash
npm run token -- --print
npm run token -- --name work --out ./token-work.json
npm run token -- --db /path/to/Cursor/User/globalStorage/state.vscdb
```

### Where Cursor stores the JWT

Default profile `User/globalStorage`:

| OS | Directory |
|---|---|
| Windows | `%APPDATA%\Cursor\User\globalStorage\` (`state.vscdb`, `storage.json`) |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/` |
| Linux | `$XDG_CONFIG_HOME/Cursor/User/globalStorage/` or `~/.config/Cursor/User/globalStorage/` (also `~/.cursor/`) |

Sign in to the Cursor app at least once. A portable install can sit anywhere — pass `--db`.

Grok Bot’s own encrypted `sand-secrets.json` is a **different** token. Do not paste it into `accessToken`.

## Checksum

Sand requests send `x-cursor-checksum`: a time-scrambled 6-byte prefix (XOR chain, seed 165, base64) plus `machineId` and optional `/macMachineId`. Wrong machine ids produce auth failures that look like a dead JWT. `npm run token` fills both ids from the same Cursor profile that issued the JWT.

## Rotation and hygiene

- Re-run `npm run token` after signing into Cursor again (JWT expiry is the `exp` claim).
- Revoke a leaked `crsr_` key in the dashboard; delete that object from `token.json`.
- `token-disabled.json` (next to `TOKEN_FILE`) is a local cache of models the converter stopped offering on a given credential (quota / plan). It is gitignored. Deleting it only refreshes the catalog, it does not restore Cursor quota.
- Do not put `token.json` on a shared volume or in a container image.

Next: [configuration](./configuration.md) · [deployment](./deployment.md)
