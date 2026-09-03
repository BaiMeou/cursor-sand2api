[English](./SECURITY.md) | **中文**

# 安全

cursor-sand2api 持有**你的** Cursor 登录态（sand IDE JWT）和/或**你的**官方 Cursor User API Keys（`crsr_…`）。把进程、`token.json` 以及前面的任何反向代理都当成凭据仓库来对待。

本文是默认安装的威胁模型。绑定回环以外的地址前，先读 [配置](docs/zh/configuration.md) 和 [部署](docs/zh/deployment.md)。

## 空的 `API_KEY`

默认：`API_KEY` 为空，且 `HOST=127.0.0.1`。

- 在**回环**（`127.0.0.1`、`::1`、`localhost`）上，空密钥表示**不做 `Authorization` 检查**。本机任何进程都能打 `/v1/*`。这对单用户工作站是故意的。若机器上还有其他用户或沙箱应用，请设置 `API_KEY`。
- 在**非回环**绑定（`0.0.0.0`、局域网地址、公网地址）上，空 `API_KEY` 会被拒绝：进程**退出**，并提示 `Set API_KEY before binding to a non-loopback address`。不要把这条守卫补丁掉。

`API_KEY` 是**本转换器**的共享密钥，不是 Cursor token。它永远不能替代 `token.json`。以 `Authorization: Bearer <API_KEY>` 发送。

## Web 控制台（`WEB_UI`）

`public/` 下的文件是**无需鉴权的静态资源**。它们把转换器 API key 存在浏览器里（`localStorage` 键 `sand2api.state.v1`），然后和其它客户端一样调用 `/v1/*`。

- 默认：仅当 `HOST` 是回环时 UI 为 **on**。绑定非回环地址会把 UI 关掉，除非你显式设置 `WEB_UI=on`。
- **不要**在 `0.0.0.0` 或公网接口上提供控制台。反向代理后面优先 `WEB_UI=off`；若要 UI，另开一个本地 `127.0.0.1` 进程。
- 页面本身不是秘密。危险在于：可访问的 UI + 被偷走或为空的 `API_KEY`，就变成远程消耗 Cursor 额度的按钮。

## `token.json`

- 包含 sand JWT（`accessToken` + 机器 id）和/或 `crsr_` 密钥。
- **永远不要提交。** `.gitignore` 已经排除 `token.json`、`token-*.json`、`token-disabled.json` 和 `.env`。
- 写成模式 `0600`（`npm run token` 会这么做）。备份离线保存。
- 被偷的 sand JWT 等于被偷的 Cursor IDE 会话。被偷的 `crsr_` 密钥等于被偷的官方 API key。两者都要在 Cursor 控制台轮换 / 把 IDE 登出再登入。
- 导入器（`npm run token`）只打印账号标签和过期时间。它不打印 JWT。

## `/health` 与 `/health/detail`

| Route | Auth | Body |
|---|---|---|
| `GET /health` | **Public** | 仅 `{ status, version, tokens: { total, healthy } }` |
| `GET /health/detail` | 与 `/v1/*` 相同（设置了则需 `API_KEY`） | 运维内部字段（工具模式、超时、白名单、sand 用量）。用量 blob 会剥掉仪表盘 URL 及类似 PII。 |

不要在没有密钥的情况下暴露 `/health/detail`。不要把账号邮箱、JWT 前缀或 Cursor 仪表盘链接放到公开 health 路由上。负载均衡应探测 `/health`。

## CORS

`CORS_ORIGIN` 控制 `cors` 中间件：

- 回环上未设置：反射请求 origin（本地 Web 控制台可用）。
- 非回环绑定上未设置：**不要**发送 `Access-Control-Allow-Origin: *`。
- 设成你实际使用的 origin 逗号分隔白名单。
- `CORS_ORIGIN=*` 会让任何网站都能**从浏览器**调用转换器——只要受害者的 `API_KEY` 为空或漏进了 JS。不要在共享或公网绑定上使用 `*`。

## API 不得泄露什么

错误 JSON 是 `message`、`type`、`code`，外加可选的 `cursor_*` 调试字段（`cursor_error`、`cursor_title`、`cursor_detail`）、`hint`、`action_required`、`retryable`、`model`、`requested_model`、`conversation_id`。**账号名、邮箱和原始 token 不是公开错误对象的一部分。** 也不要把它们写进共享请求日志。

流式失败是**顶层** `error` 帧（见 [api.md](docs/zh/api.md)），不是假装 `200` 再把错误塞进 `delta.content`。

## 历史私有树备注

更早的私有提交记录过一次运维部署（内部主机名、示例转换器 `API_KEY`）。那些文件**不在** 1.0.0 树里。若你在公开 `v1.0.0` tag 之前克隆过本仓库，把那段历史里的任何密钥或地址都当成已泄露并轮换。公开版本应从 tag `v1.0.0`（或经过历史擦洗的默认分支）获取，而不是从 1.0.0 之前的私有主线。

## 报告漏洞

在 [BaiMeou/cursor-sand2api](https://github.com/BaiMeou/cursor-sand2api) 开 GitHub issue 或 security advisory。

**永远不要粘贴** `accessToken`、`crsr_` 密钥、`token.json`、`.env`、checksum 头，或完整的 `Authorization` 行到 issue、pull request、截图或 CI 日志里。打码写成 “sand JWT” / “crsr_ key”，并描述行为。

若你认为涉及 Cursor 本身（账号接管、上游注入），请向 Cursor 报告，而不只是这里。
