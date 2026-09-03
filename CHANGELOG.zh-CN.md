[English](./CHANGELOG.md) | **中文**

# 更新日志

本文件记录本项目所有值得注意的变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)。

## [1.0.0] — 2026-09-03

非官方 OpenAI 兼容转换器的首次公开文档发布。与 Cursor 无隶属关系。本 tag 起即为 **AGPL-3.0-or-later**。

### Added

- **Sand 聊天默认路径是 `aiserver.v1.InferenceService/Stream`。** `agent.v1.AgentService/Run` 会拒绝 sand JWT（`Sand traffic is not supported`），不再作为文档中的 sand 路由。
- **官方 `crsr_` 池**，经 `@cursor/sdk`（`Agent.create` + `send`）。对外 id 使用 `api-` 前缀。Cursor 官方 REST 仍然没有 `/v1/chat/completions`。
- **`POST /v1/responses`** 无状态子集（items、流式事件类型、function-call 回放）。`store` / 检索 / 删除 / `background` / 托管工具返回 **501**，不伪造对象。
- **错误分类**：真实 HTTP 状态与字符串 `error.code`（`unsupported_region`、`plan_restricted`、`rate_limit_exceeded`、…）。流式使用**顶层 `error` 帧**（Responses：`error` 事件）。失败绝不会假装 `200` 再把消息塞进 `delta.content`。
- **健康检查拆分：** 公开 `GET /health` 只返回 `{ status, version, tokens: { total, healthy } }`。`GET /health/detail` 需要 `API_KEY`，携带运维内部字段。
- **绑定 / `API_KEY` 守卫：** 若 `HOST` 不是回环且 `API_KEY` 为空，进程**退出**。
- **`503` `pool_exhausted`**：所需类型已无健康凭据时返回。
- **`PREFER_GROK_BOT_PLAN`**（默认 **off**）。按名称选模型时不会悄悄优先 Grok Bot Plan 账号。Grok Bot 的 `sendPrompt` 不是 Claude 路径，也未实现。
- **公开文档重写：** 英文 README 加上 `docs/*`、`SECURITY.md`、`CONTRIBUTING.md`、`.env.example` 与 `examples/`。落地页已去掉私有清单、主机名和运维笔记。
- **双语文档：** English plus 中文（`README.zh-CN.md`、`docs/zh/`）。

### Changed

- 默认 `DEFAULT_MODEL` 为 `kimi-k3`（家族）。冷却环境变量默认值为 `0`（`TOKEN_COOLDOWN_MS`、`TOKEN_AUTH_COOLDOWN_MS`、`TOKEN_RATE_LIMIT_COOLDOWN_MS`）。
- `WEB_UI` 仅在回环默认 **on**；绑定非回环地址时默认关，除非 `WEB_UI=on`。
- `GET /v1/models` 文档化为**目录**，不是套餐权益。调用时出现 `plan_restricted` / `unsupported_region` / 限流是预期行为（含 Anthropic 地理 `403`）。
- `LICENSE` 为 GNU Affero GPL v3。`package.json` 的 `license` 为 `AGPL-3.0-or-later`。把改过的版本当服务提供时必须给出对应源码。许可证不授权违反 Cursor 条款。

### Security

- 空 `API_KEY` 仅限本机。公网绑定时 CORS 默认不是 `*`。`token.json` 仍被 gitignore。公开 health 不再携带用量仪表盘或账号列表。

## [0.7.0] — 2026-08-30

历史 **0.7.0 / rc** 线（私有树，不是单独的公开 tag）。写在这里，是为了让 1.0.0 不要看起来像一次莫名其妙的跳跃。

那一代已经是把 **你自己的** Cursor 凭据转成 OpenAI Chat Completions 的转换器：默认 `TOOL_MODE=client`、本地工具循环、图片 `data:` 附件、实验性文档、提示词强制 JSON 模式、出口侧强制 `max_tokens` / `stop`，以及诚实（非 200）错误的起步。

那条线的 sand 聊天仍指向 **`AgentService/Run`**，并带 `x-cursor-client-type: sand`。官方 `crsr_` 密钥、InferenceService 作为 sand 默认、health 拆分、监听守卫，以及这套公开文档，是在走向 1.0.0 的路上加上的。
