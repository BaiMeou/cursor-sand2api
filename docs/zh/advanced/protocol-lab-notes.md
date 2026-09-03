[English](../../advanced/protocol-lab-notes.md) | **中文**

# Protocol lab notes

完整写稿：[reverse-engineering.md](./reverse-engineering.md)。本页保留 2026-08-29 关于 header 的 A/B，以及一份短握手清单。**非官方。可能会坏。**

下面 Agent 矩阵的传输：HTTP/2 ConnectRPC 到 `https://api2.cursor.sh/agent.v1.AgentService/Run`，`content-type: application/connect+json`，5 字节信封。

1.0.0 里 sand **聊天**默认走 `https://api2.cursor.sh/aiserver.v1.InferenceService/Stream`。header 效果仍然重要：`x-cursor-client-type` 选择额度桶。`AgentService/Run` 现在会**拒绝** sand JWT（`Sand traffic is not supported`）。

## 起作用的头

官方 Grok Bot 的 `getSandBackendClientHeaders()`：

```text
x-cursor-client-type: sand
x-cursor-client-version: 0.30.0
x-sand-box-namespace: prod
```

省略 `x-cursor-client-type` 的客户端被视为 IDE / Other Models。

本转换器默认类型 `sand`、版本 `3.17.21`、命名空间 `prod`。

## 矩阵（提示词：`Reply with exactly: pong`）

同一条 JWT，`AgentService/Run`，2026-08-29：

| Variant | type | namespace | version | `kimi-k3-max` | `cursor-grok-4.6-high` |
|---|---|---|---|---|---|
| A | *(none)* | | 3.17.21 | Other Models limit ~0.9s | pong ~2.7s |
| B | `ide` | | 3.17.21 | Other Models limit ~0.9s | pong ~2.8s |
| C | `sand` | | 3.17.21 | **pong ~2.1s** | pong ~2.9s |
| D | `sand` | `prod` | 3.17.21 | **pong ~1.9s** | pong ~2.8s |
| E | `sand` | `prod` | `0.30.0` | **pong ~2.0s** | pong ~2.7s |

裸的 `kimi-k3` 在两个池上都被拒（`Model name is not valid`）。对外 id `kimi-k3` 是家族；转换器在 sand Inference 前映射到变体 slug。

`x-sand-box-namespace: prod` **不是** Other Models → sand 池切换所必需的。官方 Bot 仍会发送它。

这是**换池**，不是无限额度。sand 周桶空了，调用会像其它限额一样失败。

## 握手（Agent）

Sand（以及常常是 IDE）会在 token 之前发送 `execServerMessage.requestContextArgs`。用 `execClientMessage.requestContextResult.success` 回复，否则流永远不会 `turnEnded`。第一次探测在这里挂了大约 7 分钟，直到有了 exec 处理。

无头默认：拒绝 shell/read/ls/grep/write；空诊断；回答网页搜索**批准**查询（`WEB_SEARCH=off` 时拒绝），以免流卡在未回答的提示上。

InferenceService/Stream 不用那套双向 exec 循环。工具结果是带 OpenAI 历史的**新** HTTP 请求。

## 不是这套协议

Grok Bot 桌面聊天是：

1. `aiserver.v1.GrokBotService/EnsureSandBox`
2. `POST {gatewayUrl}/api/sendPrompt`，body 为 `{ agentId, prompt, … }` —— **没有模型 id**

那条路径上的模型住在主机设置里（`agentDefaultModel` / `computerUseModel`）。asar 里 computer-use 默认 id 是 `grok-4.5`。**`sendPrompt` 不能选择 Claude。** 本转换器不实现 Bot 网关。

官方 User API Keys（`crsr_`）是第四条路径：`@cursor/sdk`，不是带 sand JWT 的 Connect `Run`。
