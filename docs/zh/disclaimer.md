[English](../disclaimer.md) | **中文**

# 免责声明

**cursor-sand2api 是非官方的。** 它与 Anysphere、Cursor，或 `/v1/models` 里出现的任何模型提供商都没有隶属、背书或支持关系。Cursor 的名称、产品和 API 属于他们。

本转换器用**你自己的** Cursor 凭据与 Cursor 现有后端对话，再把结果重述成一小块 OpenAI 兼容 HTTP 表面。它不是 Cursor 产品，不是公开的 Cursor API，也不能替代 [Cursor 官方 API 与 SDK](https://cursor.com/docs)。

## 服务条款

使用本软件意味着你发出的流量看起来像（或就是）Cursor IDE / Cursor API 用量，计费和限额与 Cursor 对该账号的既有方式相同。你负责：

- 遵守 [Cursor’s Terms of Service](https://cursor.com/terms) 以及适用于你套餐的任何模型提供商条款
- 保管好凭据
- 因你发出的请求而产生的额度、花费或账号处置

不要用本项目把一份付费会员分享给无权使用的人、规避套餐限额，或假装这个 HTTP 端口是官方 Cursor 端点。

## 额度与计费

每一次成功或重试的回合都消耗**你的** Cursor 用量：sand / Bot 周池、IDE “Other Models” 池、官方 User API Key（`crsr_`）额度，或 Cursor 为该凭据和模型分配的任何桶。`GET /v1/models` 列出某个模型**并不**意味着下一次调用会成功，也不意味着免费。

Cursor 可能返回 `429`（限流 / 用量）、`403` `plan_restricted`（套餐不能跑该命名模型），或 `403` `unsupported_region`（提供商对该账号或出口地区封锁）。那些是 Cursor 的答复，不是转换器的 bug。

## 它可能会坏

Cursor 可以不预先通知就改 RPC 路径、header、checksum、模型 slug、套餐规则或地理策略。今天还能用的 sand JWT，明天就可能被拒（`AgentService/Run` 上的 `Sand traffic is not supported` 已经是硬例子）。把本项目当成**尽力而为的逆向适配器**。钉死一个发行版，留好回滚，不要做「Cursor 改一个 header 就完蛋」的生意。

不完整的 OpenAI 表面见 [限制](./limitations.md)，token 如何存放见 [凭据](./credentials.md)。

## 许可证

转换器本身是 [AGPL-3.0-or-later](../../LICENSE)。它管的是**本仓库源码**，不是 Cursor。AGPL 不会让违反 Cursor 条款变成合法。
