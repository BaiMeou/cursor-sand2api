[English](../configuration.md) | **中文**

# 配置

所有设置都是环境变量。除了 `token.json`（见 [凭据](./credentials.md)）没有其它配置文件。复制 [.env.example](../../.env.example) 并自己 export，或在命令行传入变量。

走共享解析器的布尔变量接受 `1` / `true` / `yes` / `on`（不区分大小写）。`ENABLE_SHELL` 更严：只有 `1` 或 `true`。`ENABLE_FETCH` 除非设为 `0` 否则为开。

不要发明本表没有的名字。没有 `API_KEY` 就不要绑定公网地址。不要在 `0.0.0.0` 上打开 `WEB_UI=on`。

## 进程与 HTTP

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址。除非设置 `API_KEY`，否则只回环。 |
| `PORT` | `13000` | 监听端口。 |
| `API_KEY` | *(empty)* | `/v1/*` 与 `/health/detail` 的共享密钥。空值**仅**允许在回环上；非回环绑定若为空则**退出**。发送 `Authorization: Bearer …`。 |
| `WEB_UI` | 回环：**on**；非回环：**off** | 在 `/` 提供 `public/`。显式 `on` / `off` / `1` / `0` / `true` / `false` / `yes` / `no`。未设置则跟随绑定：`127.0.0.1` / `::1` / `localhost` 开 UI，其它关。**不要在公网绑定上启用。** |
| `CORS_ORIGIN` | 回环：反射请求 origin；非回环：没有 `*` | `*` 允许任意浏览器 origin（密钥为空或泄露时很危险）。逗号分隔列表作白名单。回环上未设置可让本地控制台工作。 |
| `TOKEN_FILE` | `./token.json` | 凭据池路径。 |
| `MAX_BODY_SIZE` | `64mb` | Express JSON 上限。一整回合可以是 15 MB 图片 + 20 MB 文档，再加上 base64。 |

## Cursor 客户端（sand JWT）

| Variable | Default | Meaning |
|---|---|---|
| `CURSOR_BASE_URL` | `https://api2.cursor.sh` | ConnectRPC 主机。 |
| `CURSOR_CLIENT_VERSION` | `3.17.21` | `x-cursor-client-version`。尽量靠近你导入时所在的 Cursor 应用。`0.30.0` 也作为 sand 被接受。 |
| `CURSOR_CLIENT_TYPE` | `sand` | `x-cursor-client-type`。`sand` 是默认聊天路径（`InferenceService/Stream`，sand / Bot 周池）。`ide`（或旧客户端里为空）视为 IDE / Other Models，走 `AgentService/Run`。 |
| `SAND_BOX_NAMESPACE` | `prod` | 类型为 `sand` 时的 `x-sand-box-namespace`。官方 Bot 发送 `prod`。 |
| `CURSOR_USER_AGENT` | `connect-es/1.6.1` | HTTP `user-agent`。 |
| `CURSOR_ACCEPT_GZIP` | off | 若开，发送 `connect-accept-encoding: gzip`。帧随后可能带 flag `0x01`。 |
| `CURSOR_GHOST_MODE` | *(empty)* | 若设为 `true` 或 `false`，发送 `x-ghost-mode`。 |
| `CURSOR_ALLOWED_NATIVE_TOOLS` | *(empty → no header)* | 逗号分隔的名字，用于 `x-cursor-agent-allowed-tools`。空或 `*` 则省略该头（Cursor 的完整原生集合）。示例：`mcp_tool_call,get_mcp_tools_tool_call`。这是阻止 Agent 路径广告几十个内置工具的唯一可靠办法；InferenceService 在 tools 为空的回合不需要它。 |
| `DEFAULT_MODEL` | `kimi-k3` | 请求省略 `model` 时使用。家族名；需要时 sand 仍会和上游说变体 slug。 |

## 超时

| Variable | Default | Meaning |
|---|---|---|
| `REQUEST_TIMEOUT` | `300000` | 整次请求预算（毫秒）。工具循环可以比单次模型调用更长。 |
| `IDLE_TIMEOUT` | `120000` | 完全没有入站帧（含心跳）→ socket 已死。 |
| `OUTPUT_TIMEOUT` | `240000` | 帧还在到，但没有一个是模型输出 → 回合卡住了（例如在等 exec 握手）。仅由 text/thinking delta 重置。调用方被期望跑工具时，两座时钟都会让出。 |

## Token 池冷却

默认**关闭**。`429` 是共享的 Cursor 用量，不是死凭据；把 JWT 停用只会藏起一个仍能用的账号。

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_COOLDOWN_MS` | `0` | 一般失败后，暂停该账号（毫秒）。`0` = 不暂停。 |
| `TOKEN_AUTH_COOLDOWN_MS` | `0` | `401` / 大多数 `403` 后的额外暂停。`0` = 不暂停。 |
| `TOKEN_RATE_LIMIT_COOLDOWN_MS` | `0` | 若 `> 0`，在 `429` 上设置 HTTP `Retry-After`。账号**仍然不会**因共享用量被停用。 |

当所有匹配凭据都缺失、过期或正在冷却时，转换器返回 **503** `pool_exhausted`，而不是假装 `200`。

## 模型与调试

| Variable | Default | Meaning |
|---|---|---|
| `MODEL_CACHE_TTL_MS` | `900000` | `/v1/models` 与每账号目录的缓存时长。 |
| `MODEL_ERROR_CACHE_TTL_MS` | `30000` | 目录拉取失败后的缓存 TTL。 |
| `MODEL_PARAMETERS` | off | 对照账号目录解析调用方名字，并把 `reasoning_effort` / `reasoning.effort` / `thinking.effort`（以及 kimi 的 `-low`/`-high`/`-max` 后缀）变成 Cursor 实际跑的 slug。关：按映射名原样发送。 |
| `DEBUG_TOOL_TRACE` | off | 若开，成功响应可能包含 `tool_trace`（exec 名、路径、命令）。任何共享进程都关掉。 |
| `DEBUG_PROMPT` | off | 记录实际发送提示词的前约 1200 个字符。 |

## 工具与工作区

| Variable | Default | Meaning |
|---|---|---|
| `TOOL_MODE` | `client` | `client` — 返回 OpenAI `tool_calls`；由**你**执行。`workspace` — 本进程在 `WORKSPACE_DIR` 下执行 Cursor 内置工具（仅本地调试）。`none` — 拒绝工具。 |
| `WORKSPACE_DIR` | `./workspace` | `TOOL_MODE=workspace` 的根。请求的 `workspace` / `cwd` / 头 `X-Workspace` 是给模型的上下文，不是 `client` 路径上的沙箱逃生口。 |
| `ENABLE_SHELL` | off | 仅 `workspace` 模式。设 `1` 或 `true` 以允许 `shell`。 |
| `ENABLE_FETCH` | on | 仅 `workspace` 模式。设 `0` 以拒绝 `web_fetch`。 |
| `SHELL_TIMEOUT_MS` | `30000` | `workspace` shell 超时。 |
| `DECLARE_MCP_TOOLS` | off | Agent 路径：把调用方的函数声明为 `McpToolDefinition`，让模型发出真正的 MCP 调用而不是 `invoke_client_tool` 文本。除非你知道自己需要，否则在 Inference 上关掉。 |
| `CONVERSATION_HISTORY` | off | **实验性。** Agent 路径：把历史作为 KV blob 发送（`conversationState` + sha256 拉取），而不是压扁成一个用户回合。在 `sand` + `connect+json` 上未经测试。InferenceService 每回合已经重新 POST 消息列表。 |
| `SYSTEM_AS_HISTORY` | on | Agent 路径：Cursor 会丢掉真正的 `system` 角色；把它改写成 user/assistant 开场交换。InferenceService 有真正的 SYSTEM 角色，不需要这个。 |
| `CONTINUATION_PROMPT` | `Continue, using the tool results above.` | Agent 路径：历史以工具结果结尾且没有新用户行时发送的文本。 |
| `WEB_SEARCH` | off | 允许 Cursor 跑**它自己的**网页搜索（批准握手 + `agent-tools/` 草稿）。消耗该账号额度。默认关，以免陌生人的提示词去烧搜索。 |
| `PREFER_GROK_BOT_PLAN` | `false` | 若为 `true`，按名称选 sand 时优先用量标签为 **Grok Bot Plan** 的凭据（不是 SuperGrok / SuperGrok Heavy）。SuperGrok 对许多命名 Claude/Kimi slug 仍会 `403`，文案是花费限额（`plan_restricted`）。默认 **off**：不要悄悄跳账号。 |

`PREFER_GROK_BOT_PLAN` 不是 Claude 开关，也不会启用 Grok Bot 的 `sendPrompt`。

## 短示例

回环，设好密钥（即使在家也建议如此）：

```bash
HOST=127.0.0.1 PORT=13000 API_KEY=changeme npm start
```

只要 API，仍回环：

```bash
HOST=127.0.0.1 WEB_UI=off API_KEY=changeme npm start
```

同一台机器上的反向代理应让本进程留在 `127.0.0.1` 并设置 `API_KEY`。见 [部署](./deployment.md)。
