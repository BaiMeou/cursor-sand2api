# Reverse-engineering notes (unofficial)

**English** | [中文](../zh/advanced/reverse-engineering.md)

> **Unofficial. May break.** This is not a Cursor API specification. Cursor can change RPCs, headers, checksums, or plan rules without notice. These notes exist so contributors can see **why** the converter speaks the way it does. They describe traffic from **your own** signed-in Cursor client, not a public product contract.

Implementation: `src/cursor-client.js`, `src/inference-protocol.js`, `src/chat-transport.js`, `src/connect-frame.js`. Model-facing XML the IDE injects: [system-context.md](./system-context.md). Lab A/B: [protocol-lab-notes.md](./protocol-lab-notes.md).

Observed against Cursor IDE **3.17.21** and the official Grok Bot desktop `app.asar` (2026-08-29 … 2026-09-02). Field names are proto3 JSON (camelCase) over Connect.

---

## 1. Three paths (only two are used here)

| | Sand chat (**this repo default**) | IDE Agent | Official User API Key | Grok Bot desktop |
|---|---|---|---|---|
| Host | `https://api2.cursor.sh` | same | `https://api.cursor.com` + SDK | Control plane same; chat on a dynamic `gatewayUrl` |
| RPC | **`aiserver.v1.InferenceService/Stream`** | `agent.v1.AgentService/Run` | `@cursor/sdk` `Agent.create` / `send` (official REST has **no** `/v1/chat/completions`) | `aiserver.v1.GrokBotService/EnsureSandBox` then JSON |
| Auth | IDE JWT + checksum | IDE JWT + checksum | `crsr_…` | Bot gateway token (**not** the IDE JWT) |
| Sand JWT | **Accepted** | **Rejected:** `Sand traffic is not supported` | N/A | N/A |
| Model field | `model` / `requestedModel.modelId` | `requestedModel.modelId` | SDK model id | **`sendPrompt` has no model field** |
| Quota | Sand / Bot weekly pool | Other Models | Official API quota | Sand / Bot weekly pool |

Grok Bot `sendPrompt` cannot pick Claude (or Kimi, or anything else) per request. Model lives in host settings (`agentDefaultModel` / `computerUseModel`). **Do not document or implement that gateway as a Claude path.** This converter does not call it.

A third-party IDE patch that rewrites `'ide'` → `'sand'` inside Cursor’s install is a different approach. This repo does **not** modify Cursor files. It sends the official sand client-type header from Node.

---

## 2. Authentication (sand)

Values come from a local Cursor profile. **Do not commit them.** See [credentials](../credentials.md).

| Field | Typical location |
|---|---|
| `accessToken` | `state.vscdb` → `ItemTable` key `cursorAuth/accessToken` |
| `machineId` | sibling `storage.json` → `telemetry.machineId` |
| `macMachineId` | `telemetry.macMachineId` |

### Checksum

`x-cursor-checksum` = time-scrambled 6-byte XOR chain (seed **165**), base64, then `machineId`, then optional `/` + `macMachineId`.

```javascript
function generateChecksum(machineId, macMachineId) {
  let k = 165;
  const t = Math.floor(Date.now() / 1e6);
  const b = new Uint8Array([
    (t >> 40) & 255, (t >> 32) & 255, (t >> 24) & 255,
    (t >> 16) & 255, (t >> 8) & 255, t & 255,
  ]);
  for (let i = 0; i < b.length; i++) {
    b[i] = ((b[i] ^ k) + (i % 256)) & 0xff;
    k = b[i];
  }
  const prefix = Buffer.from(b).toString("base64");
  return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}
```

Grok Bot asar uses the same `createCursorChecksum`. Official Bot sometimes omits `macMachineId` and uses base64url; IDE-shaped requests that include both ids still work.

---

## 3. Transport (Connect)

- HTTP/2 to `https://api2.cursor.sh`
- `connect-protocol-version: 1`
- **Unary** (`GetUsableModels`, `AvailableModels`, dashboard): `content-type: application/json`, one JSON body
- **Streams** (`InferenceService/Stream`, `AgentService/Run`): `content-type: application/connect+json`, 5-byte envelopes

Frame:

```text
1 byte flag
4 bytes length (big-endian)
N bytes payload
```

Flags **must** be read (`src/connect-frame.js`):

| Flag | Meaning |
|---|---|
| `0x00` | Raw JSON message |
| `0x01` | gzip payload; decompress before `JSON.parse` |
| `0x02` | End-of-stream trailer; Connect **stream errors live here**. HTTP status is still 200 |

Ignoring flags looks like an “empty upstream”: gzip frames fail `JSON.parse` and are dropped; `0x02` errors are missed unless the trailer happens to look like `{"error":{...}}`.

This converter sends flag `0`. Heartbeats: `{ "clientHeartbeat": {} }` about every 5s. Do not `req.end()` before the turn finishes.

Heartbeats prove the socket is alive, not that the model is producing. Two clocks (`src/watchdog.js`): `IDLE_TIMEOUT` resets on any inbound frame (dead socket); `OUTPUT_TIMEOUT` resets only on text/thinking (wedged handshake).

EOF before a normal end is **truncation**, not `finish_reason: "stop"`.

---

## 4. InferenceService/Stream (sand default)

```http
POST /aiserver.v1.InferenceService/Stream
```

Unary **server-streaming**. Tool results **cannot** be written back on the same HTTP/2 stream; the next OpenAI request re-POSTs the full message list. That is why `createInferenceRun`’s `submit()` is a no-op.

Typical headers:

```text
authorization: Bearer <accessToken>
x-cursor-checksum: <above>
x-cursor-client-version: 3.17.21
x-cursor-client-type: sand
x-sand-box-namespace: prod
x-cursor-timezone: <IANA>
x-request-id: <uuid>
```

Inference has a real **SYSTEM** role and a real `tools` field. An empty tools list means the model has no tools. The caller’s `role: system` should arrive as system (`src/inference-prompt.js`), not as a fake user/assistant exchange.

`modelConfig` may carry `maxTokens`, `stopSequences`, `temperature`, `topP`.

Images/documents on the current user turn go as Inference parts (`data:` base64). History attachments are not re-uploaded.

Stream errors often have `errorType` plus a `details[0].debug` object. `message` is frequently the literal `"Error"` — classify `debug.error` (`ERROR_UNSUPPORTED_REGION`, …) first.

---

## 5. AgentService/Run (not the sand default)

```http
POST /agent.v1.AgentService/Run
```

**BiDi** stream. First message is `runRequest` with `userMessage`, `requestedModel.modelId`, `conversationId`.

With `x-cursor-client-type: sand`, Cursor answers **`Sand traffic is not supported`**. Official `crsr_` traffic and `CURSOR_CLIENT_TYPE=ide` still use this family of APIs (IDE / Other Models pool).

The server often sends `execServerMessage.requestContextArgs` before tokens. Headless clients **must** reply with `execClientMessage.requestContextResult` (OS + shell stub is enough to unblock). Ignoring it hangs the stream (minutes of heartbeats, no `turnEnded`).

Other execs (read / ls / shell / …) are refused unless `TOOL_MODE=workspace`. Web-search approval queries must be answered even when `WEB_SEARCH=off`, or any turn that asks will hang.

Downlink oneofs include `error`, `execServerMessage`, `kvServerMessage`, `interactionUpdate.textDelta` / `thinkingDelta` / `turnEnded`.

---

## 6. ChatService (not default)

`aiserver.v1.ChatService/StreamUnifiedChatWithTools` accepts sand but has been observed as `resource_exhausted` rather than a client-type denial. `StreamUnifiedChat` / `AiService/StreamChat*` / `StreamComposer` accept sand and return “upgrade Cursor” / Deprecated — **not model tokens**. `AiService/StreamGenerate` / `StreamEdit` are Cmd+K / inline edit, not chat; stuffing a chat body there writes the upgrade nag into `content`.

The converter stays on Inference unless a live matrix file says another RPC actually produced tokens for that family. That matrix path is an operator probe, not a supported env for public installs.

---

## 7. Model catalog

```http
POST /agent.v1.AgentService/GetUsableModels
content-type: application/json

{}
```

Returns `{ "models": [ { "modelId": "..." }, ... ] }` — names the account may run.

```http
POST /aiserver.v1.AiService/AvailableModels
```

Metadata (context window, images, thinking, parameter definitions). **`useModelParameters: true`** is required to get parameter tables; without it the list is long and empty of params.

`GET /v1/models` merges both. Either RPC can fail without emptying the list. **Listing is not entitlement** — see [limitations](../limitations.md).

Family vs slug: public ids are families (`kimi-k3`). Sand Inference still wants a variant slug (`kimi-k3-max`, `kimi-k3-low`, …). Bare `kimi-k3` was rejected on Agent (`Model name is not valid`). `MODEL_PARAMETERS` maps `reasoning_effort` onto those slugs. Official SDK wants the **base** id plus parameters (`kimi-k3` + `reasoning=max`).

---

## 8. Client-type and quota (lab)

Same JWT, same model id, `AgentService/Run` (2026-08-29): omitting `x-cursor-client-type` or sending `ide` billed **Other Models**. Sending `sand` billed the **sand / Bot weekly pool**. `x-sand-box-namespace: prod` was not required for that swap; official Bot still sends it.

This is **not** unlimited usage. When the weekly pool is empty, calls stop. Cursor can start verifying the real client at any time.

`DashboardService/GetSandUsageStatus`, `GetHardLimit`, `AiService/TimeLeftHealthCheck` accept sand and are operator-only (`/health/detail`). `DashboardService/GetMe` and `AuthService/GetEmail` also accept sand — **never** attach them to public `/health`.

---

## 9. Official `crsr_` keys

Dashboard User API Keys. The SDK opens an agent run and streams events. This converter disables Cursor’s ambient shell/read/edit/web tools and only forwards functions the OpenAI caller declared. Prefix `api-` on the public surface so sand and official catalogs do not collide.

Startup may probe `kimi-k3` on each `crsr_` key. “You’ve hit your usage limit / API model usage” drops that model from that key’s catalog until reset.

---

## 10. Known traps

- Pin `x-cursor-client-version` near the installed Cursor (or Bot `0.30.0`). Ancient pins expire.
- Empty completions: usually a missed exec/approval handshake, not a “successful empty model.”
- `prompt_tokens` on Agent can be huge: Cursor injects its own system prompt. Inference still does not receive **your** `AGENTS.md` unless you send it.
- Connect `unauthenticated:` on a provider refusal is **not** always a dead JWT. Classify content-policy / region codes first.
- CN / geo: Anthropic often `ERROR_UNSUPPORTED_REGION` wrapped as `resource_exhausted` + message `Error`.
