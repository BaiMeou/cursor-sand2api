[English](./README.md) | **中文**

# cursor-sand2api

非官方、OpenAI 兼容的 HTTP 转换器，只使用**你自己的** Cursor 凭据。

- **Sand IDE JWT** → Cursor ConnectRPC。聊天默认走 `aiserver.v1.InferenceService/Stream`。
- **官方 User API Keys**（`crsr_…`）→ [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk)（`Agent.create` + `send`）。

版本 **1.0.0**。[AGPL-3.0-or-later](./LICENSE)。**与 Cursor / Anysphere 无任何隶属关系。** 本仓库故意设为 `private: true`——**不是** npm 包。

`agent.v1.AgentService/Run` **会拒绝** sand JWT（`Sand traffic is not supported`）。不要按「sand 聊天仍走 AgentService」来配置本项目。Grok Bot 桌面端的 `sendPrompt` **没有 model 字段**，无法选择 Claude；该网关本仓库未实现。

## 免责声明

这是一个逆向适配器，跑在**你自己的** Cursor 登录态和额度上。Cursor 一旦改 header、RPC 或套餐规则，它就可能坏掉。Cursor 的条款、花费和凭据卫生由你自己负责。

运行前请先读 **[docs/zh/disclaimer.md](docs/zh/disclaimer.md)**。

## 它是什么

一个小型 Node HTTP 服务（默认 `HOST=127.0.0.1`、`PORT=13000`）：接受 OpenAI Chat Completions / Completions / Responses 的一个子集，用**你的** `token.json` 和 Cursor 对话，再返回 OpenAI 形状的 JSON 或 SSE。

它不是 Cursor 官方 API，不是多租户代理，也不是完整的 OpenAI 克隆。`GET /v1/models` 是**目录**，不是套餐权益。

## 功能

- 单文件双池：sand JWT + 官方 `crsr_` 密钥，轮询，并在安全时故障转移
- Sand 聊天走 **InferenceService/Stream**；官方 id 带 `api-` 前缀
- 流式使用**顶层 `error` 帧**（不会假装 `200` 再把错误写成正文）
- 客户端工具循环（`TOOL_MODE=client`）：`tool_calls` 由你在本地执行
- 无状态 Responses 子集；store / 检索 / 托管工具如实返回 **501**
- 绑定守卫：若不在回环上监听且未设 `API_KEY`，进程会**退出**
- 公开 `/health` 与需鉴权的 `/health/detail`
- 可选的简体中文 Web 控制台，仅回环
- `npm run token` 从本机 Cursor 安装导入 sand JWT（需要 Node 22.5+）

## 运行要求

- **Node.js 18.18+**：跑服务端和 `npm test`
- **Node.js 22.5+**：跑 `npm run token`（`node:sqlite`）
- 你有权使用的 Cursor 账号，以及你自己拥有的凭据
- 磁盘上的 `token.json`（永远不要提交）

## 快速开始

你真该让你的agent来读这一段，人们总是难以理解这些文档不是吗？

```bash
git clone https://github.com/BaiMeou/cursor-sand2api.git
cd cursor-sand2api
npm install
npm run token          # 从本机 Cursor 应用导入 sand JWT → token.json
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

脚本：[examples/chat-completions.sh](examples/chat-completions.sh)、[examples/tool-loop.sh](examples/tool-loop.sh)。

`GET http://127.0.0.1:13000/health` 公开，只返回 `{ status, version, tokens: { total, healthy } }`。

## 凭据

| `kind` | 你提供 | 上游 |
|---|---|---|
| `sand` | `accessToken` + 机器 id | InferenceService/Stream（默认） |
| `api` | `apiKey`（`crsr_…`） | 官方 `@cursor/sdk` |

`npm run token` 标志：`--print`、`--force`、`--name`、`--out`、`--db`。完整 schema 与各系统路径见 **[docs/zh/credentials.md](docs/zh/credentials.md)**。

**永远不要提交 `token.json`。**

## 配置

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | 非回环必须设 `API_KEY`，否则进程退出 |
| `PORT` | `13000` | |
| `API_KEY` | *(empty)* | 非回环必填。`/v1/*` 的 Bearer token |
| `WEB_UI` | 仅回环时 **on** | 公网绑定时默认关，除非 `WEB_UI=on`——别这么干 |
| `DEFAULT_MODEL` | `kimi-k3` | |
| `TOOL_MODE` | `client` | 还有 `workspace` / `none` |
| `TOKEN_*_COOLDOWN_MS` | `0` | 不要因为共享的 `429` 就把 JWT 停用 |
| `PREFER_GROK_BOT_PLAN` | `false` | 不要悄悄跳到 Grok Bot Plan 账号 |

完整表（含 `CURSOR_*`、超时、工具、历史标志）：**[docs/zh/configuration.md](docs/zh/configuration.md)** 与 [.env.example](./.env.example)。

## API 用法

```text
POST /v1/chat/completions
POST /v1/completions
POST /v1/responses          # stateless subset
GET  /v1/models             # catalog, not entitlement
GET  /v1/models/{id}
GET  /health                # public
GET  /health/detail         # API_KEY
```

即使模型列在目录里，调用时仍可能遇到 `plan_restricted`、`unsupported_region`（从 CN 或其他地区打 Anthropic）以及限流。错误是 JSON `{ message, type, code }`，外加可选的 `cursor_*` 调试字段——**不含账号名**。流式使用顶层 `error` 帧。

**501**（不伪造）：embeddings、images、audio、moderations、Responses store/get/delete、`background`、托管工具。

细节见 **[docs/zh/api.md](docs/zh/api.md)**。

## Web 控制台

回环上打开 `http://127.0.0.1:13000`。界面本身已是 zh-CN 静态页，状态存在 `localStorage` 键 `sand2api.state.v1`，徽章来自 `/health`，运维 JSON 来自 `/health/detail`。任何共享主机都设 `WEB_UI=off`。**不要把 UI 暴露在 `0.0.0.0`。**

**[docs/zh/web-console.md](docs/zh/web-console.md)**

## 部署

绑定 `127.0.0.1`，设置 `API_KEY`，设置 `WEB_UI=off`，TLS 放在反向代理上。通用 systemd + Caddy/nginx 草案：**[docs/zh/deployment.md](docs/zh/deployment.md)**。

## 限制

不是完整的 OpenAI API。列出 ≠ 有权使用。套餐桶（sand 周额度 / Other Models / 官方 API / SuperGrok）不共享剩余额度。文档附件和 `CONVERSATION_HISTORY` 是实验性的。什么都不存储（`store: false`）。本进程不会注入你项目的 `AGENTS.md`。

**[docs/zh/limitations.md](docs/zh/limitations.md)**

协议内部：[docs/zh/advanced/reverse-engineering.md](docs/zh/advanced/reverse-engineering.md) · [system-context.md](docs/zh/advanced/system-context.md) · [protocol-lab-notes.md](docs/zh/advanced/protocol-lab-notes.md)

## 开发

```bash
npm test          # node --test test/*.test.js
```

见 **[CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)**、**[SECURITY.zh-CN.md](SECURITY.zh-CN.md)** 与 **[CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)**。不要提交包含 `token.json` 或真实密钥的 PR。

## 许可证

[GNU Affero General Public License v3.0 或后续版本](./LICENSE) — Copyright (c) 2026 BaiMeou and cursor-sand2api contributors。

你可以运行、修改、分享本转换器。若把改过的版本作为网络服务提供，必须向使用者提供对应源码（AGPL §13）。许可证**不**等于允许违反 Cursor 条款。法律文本以英文 `LICENSE` 为准。

Cursor 是其所有者的商标。本项目为非官方项目。
