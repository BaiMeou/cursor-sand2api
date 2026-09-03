[English](../../advanced/reverse-engineering.md) | **中文**

# Reverse-engineering notes (unofficial)

> **非官方。可能会坏。** 这不是 Cursor API 规范。Cursor 可以不预先通知就改 RPC、header、checksum 或套餐规则。这些笔记是为了让贡献者看见转换器**为什么**这样说话。它们描述的是**你自己**已登录 Cursor 客户端的流量，不是公开产品合同。

实现：`src/cursor-client.js`、`src/inference-protocol.js`、`src/chat-transport.js`、`src/connect-frame.js`。IDE 注入的面向模型 XML：[system-context.md](./system-context.md)。实验室 A/B：[protocol-lab-notes.md](./protocol-lab-notes.md)。

对照 Cursor IDE **3.17.21** 与官方 Grok Bot 桌面 `app.asar` 观察（2026-08-29 … 2026-09-02）。字段名是 Connect 上的 proto3 JSON（camelCase）。

---

## 1. 三条路径（这里只用两条）

| | Sand 聊天（**本仓库默认**） | IDE Agent | 官方 User API Key | Grok Bot 桌面 |
|---|---|---|---|---|
| Host | `https://api2.cursor.sh` | 相同 | `https://api.cursor.com` + SDK | 控制面相同；聊天在动态 `gatewayUrl` 上 |
| RPC | **`aiserver.v1.InferenceService/Stream`** | `agent.v1.AgentService/Run` | `@cursor/sdk` `Agent.create` / `send`（官方 REST **没有** `/v1/chat/completions`） | `aiserver.v1.GrokBotService/EnsureSandBox` 然后 JSON |
| Auth | IDE JWT + checksum | IDE JWT + checksum | `crsr_…` | Bot 网关 token（**不是** IDE JWT） |
| Sand JWT | **接受** | **拒绝：** `Sand traffic is not supported` | N/A | N/A |
| Model field | `model` / `requestedModel.modelId` | `requestedModel.modelId` | SDK model id | **`sendPrompt` 没有 model 字段** |
| Quota | Sand / Bot 周池 | Other Models | 官方 API 额度 | Sand / Bot 周池 |

Grok Bot 的 `sendPrompt` 不能按请求挑选 Claude（或 Kimi，或任何其它）。模型在主机设置里（`agentDefaultModel` / `computerUseModel`）。**不要把该网关文档化或实现成 Claude 路径。** 本转换器不调用它。

第三方 IDE 补丁在 Cursor 安装里把 `'ide'` 改写成 `'sand'` 是另一条路。本仓库**不**修改 Cursor 文件。它从 Node 发送官方 sand client-type 头。

---

## 2. 鉴权（sand）

值来自本机 Cursor 配置。**不要提交它们。** 见 [凭据](../credentials.md)。

| Field | Typical location |
|---|---|
| `accessToken` | `state.vscdb` → `ItemTable` 键 `cursorAuth/accessToken` |
| `machineId` | 同级 `storage.json` → `telemetry.machineId` |
| `macMachineId` | `telemetry.macMachineId` |

### Checksum

`x-cursor-checksum` = 按时间搅乱的 6 字节 XOR 链（种子 **165**），base64，然后 `machineId`，然后可选的 `/` + `macMachineId`。

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

Grok Bot asar 使用同一个 `createCursorChecksum`。官方 Bot 有时省略 `macMachineId` 并用 base64url；包含两个 id 的 IDE 形状请求仍然可用。

---

## 3. 传输（Connect）

- HTTP/2 到 `https://api2.cursor.sh`
- `connect-protocol-version: 1`
- **一元**（`GetUsableModels`、`AvailableModels`、仪表盘）：`content-type: application/json`，一个 JSON body
- **流**（`InferenceService/Stream`、`AgentService/Run`）：`content-type: application/connect+json`，5 字节信封

帧：

```text
1 byte flag
4 bytes length (big-endian)
N bytes payload
```

Flags **必须**读取（`src/connect-frame.js`）：

| Flag | Meaning |
|---|---|
| `0x00` | 原始 JSON 消息 |
| `0x01` | gzip 载荷；`JSON.parse` 前先解压 |
| `0x02` | 流结束 trailer；Connect **流错误住在这里**。HTTP 状态仍是 200 |

忽略 flags 看起来像「空上游」：gzip 帧 `JSON.parse` 失败被丢掉；除非 trailer 碰巧长得像 `{"error":{...}}`，否则会漏掉 `0x02` 错误。

本转换器发送 flag `0`。心跳：大约每 5 秒 `{ "clientHeartbeat": {} }`。回合结束前不要 `req.end()`。

心跳证明 socket 还活着，不证明模型在产出。两座时钟（`src/watchdog.js`）：`IDLE_TIMEOUT` 在任意入站帧上重置（死 socket）；`OUTPUT_TIMEOUT` 只在 text/thinking 上重置（卡住的握手）。

正常结束前的 EOF 是**截断**，不是 `finish_reason: "stop"`。

---

## 4. InferenceService/Stream（sand 默认）

```http
POST /aiserver.v1.InferenceService/Stream
```

一元 **服务端流**。工具结果**不能**写回同一条 HTTP/2 流；下一次 OpenAI 请求重新 POST 完整消息列表。这就是为什么 `createInferenceRun` 的 `submit()` 是空操作。

典型头：

```text
authorization: Bearer <accessToken>
x-cursor-checksum: <above>
x-cursor-client-version: 3.17.21
x-cursor-client-type: sand
x-sand-box-namespace: prod
x-cursor-timezone: <IANA>
x-request-id: <uuid>
```

Inference 有真正的 **SYSTEM** 角色和真正的 `tools` 字段。空工具列表表示模型没有工具。调用方的 `role: system` 应作为 system 到达（`src/inference-prompt.js`），而不是假的 user/assistant 交换。

`modelConfig` 可以携带 `maxTokens`、`stopSequences`、`temperature`、`topP`。

当前用户回合上的图片/文档作为 Inference parts（`data:` base64）。历史附件不会重新上传。

流错误常常带 `errorType` 外加 `details[0].debug` 对象。`message` 经常是字面量 `"Error"` —— 先分类 `debug.error`（`ERROR_UNSUPPORTED_REGION`、…）。

---

## 5. AgentService/Run（不是 sand 默认）

```http
POST /agent.v1.AgentService/Run
```

**双向**流。第一条消息是带 `userMessage`、`requestedModel.modelId`、`conversationId` 的 `runRequest`。

带 `x-cursor-client-type: sand` 时，Cursor 回答 **`Sand traffic is not supported`**。官方 `crsr_` 流量和 `CURSOR_CLIENT_TYPE=ide` 仍使用这一族 API（IDE / Other Models 池）。

服务端常常在 token 之前发送 `execServerMessage.requestContextArgs`。无头客户端**必须**用 `execClientMessage.requestContextResult` 回复（OS + shell 桩就足以解除阻塞）。忽略它会让流挂住（几分钟心跳，没有 `turnEnded`）。

其它 exec（read / ls / shell / …）除非 `TOOL_MODE=workspace` 否则会被拒绝。即使 `WEB_SEARCH=off`，网页搜索批准查询也必须回答，否则任何提问的回合都会挂。

下行 oneof 包括 `error`、`execServerMessage`、`kvServerMessage`、`interactionUpdate.textDelta` / `thinkingDelta` / `turnEnded`。

---

## 6. ChatService（非默认）

`aiserver.v1.ChatService/StreamUnifiedChatWithTools` 接受 sand，但观察到的是 `resource_exhausted` 而不是 client-type 拒绝。`StreamUnifiedChat` / `AiService/StreamChat*` / `StreamComposer` 接受 sand 并返回 “upgrade Cursor” / Deprecated —— **不是模型 token**。`AiService/StreamGenerate` / `StreamEdit` 是 Cmd+K / 行内编辑，不是聊天；把聊天 body 塞进去会把升级唠叨写进 `content`。

除非实机矩阵文件说另一个 RPC 确实为该家族产出了 token，否则转换器停在 Inference。那条矩阵路径是运维探测，不是公开安装支持的环境变量。

---

## 7. 模型目录

```http
POST /agent.v1.AgentService/GetUsableModels
content-type: application/json

{}
```

返回 `{ "models": [ { "modelId": "..." }, ... ] }` —— 该账号可以跑的名字。

```http
POST /aiserver.v1.AiService/AvailableModels
```

元数据（上下文窗口、图片、思考、参数定义）。**`useModelParameters: true`** 才能拿到参数表；没有它列表很长但参数是空的。

`GET /v1/models` 合并两者。任一 RPC 失败都不会把列表清空。**列出不是权益** —— 见 [限制](../limitations.md)。

家族对 slug：对外 id 是家族（`kimi-k3`）。Sand Inference 仍要变体 slug（`kimi-k3-max`、`kimi-k3-low`、…）。裸的 `kimi-k3` 在 Agent 上被拒（`Model name is not valid`）。`MODEL_PARAMETERS` 把 `reasoning_effort` 映射到那些 slug。官方 SDK 要**基础** id 加参数（`kimi-k3` + `reasoning=max`）。

---

## 8. Client-type 与额度（实验室）

同一条 JWT、同一个模型 id，`AgentService/Run`（2026-08-29）：省略 `x-cursor-client-type` 或发送 `ide` 会记到 **Other Models**。发送 `sand` 记到 **sand / Bot 周池**。那次切换不需要 `x-sand-box-namespace: prod`；官方 Bot 仍会发送它。

这**不是**无限用量。周池空了，调用就停。Cursor 随时可能开始核验真实客户端。

`DashboardService/GetSandUsageStatus`、`GetHardLimit`、`AiService/TimeLeftHealthCheck` 接受 sand，且仅供运维（`/health/detail`）。`DashboardService/GetMe` 和 `AuthService/GetEmail` 也接受 sand —— **永远不要**把它们挂到公开 `/health`。

---

## 9. 官方 `crsr_` 密钥

控制台 User API Keys。SDK 打开一次 agent run 并流式发事件。本转换器关掉 Cursor 的环境 shell/read/edit/web 工具，只转发 OpenAI 调用方声明的函数。对外表面加前缀 `api-`，以免 sand 与官方目录撞车。

启动时可能在每把 `crsr_` 密钥上探测 `kimi-k3`。「You've hit your usage limit / API model usage」会把该模型从该密钥的目录里拿掉，直到重置。

---

## 10. 已知陷阱

- 把 `x-cursor-client-version` 钉在已安装 Cursor 附近（或 Bot `0.30.0`）。太古的钉会过期。
- 空补全：通常是漏掉的 exec/批准握手，不是「成功的空模型」。
- Agent 上的 `prompt_tokens` 可能很大：Cursor 注入它自己的系统提示。除非你发送，否则 Inference 仍收不到**你的** `AGENTS.md`。
- 提供商拒绝时的 Connect `unauthenticated:` **不总是**死 JWT。先分类内容策略 / 地区码。
- CN / 地理：Anthropic 经常是包在 `resource_exhausted` + 消息 `Error` 里的 `ERROR_UNSUPPORTED_REGION`。
