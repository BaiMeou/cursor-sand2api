[English](./CONTRIBUTING.md) | **中文**

# 贡献指南

感谢帮忙。本仓库故意设为 **`private: true`**：它不是 npm 包。贡献是源码补丁，不是 registry 发布。

请先读 [docs/zh/disclaimer.md](docs/zh/disclaimer.md)。这是非官方转换器。不要提交唯一目的是向 Cursor 隐藏用量、或冒充他人会员身份的改动。

## 前提

- **Node.js 18.18+**：跑服务端和单元测试。
- **Node.js 22.5+**：若需要 `npm run token`（`node:sqlite`）。
- 任何你选择跑的实机探测，用一次性账号或你自己的 Cursor 登录。实机脚本会消耗真实额度；PR 不要求跑它们。

## 搭建

```bash
git clone https://github.com/BaiMeou/cursor-sand2api.git
cd cursor-sand2api
npm install
cp token.json.example token.json   # then fill with YOUR credentials, locally only
cp .env.example .env               # optional
```

不要提交 `token.json`、`.env`，或任何包含 JWT / `crsr_` 密钥的文件。

## 测试

套件是 Node 内置 runner。没有额外测试框架。

```bash
npm test
```

也就是 `node --test test/*.test.js`。改协议、错误、health、监听守卫或 OpenAI 门面的 PR，应在 `test/` 里新增或更新测试。

可选实机检查（烧额度，需要正在运行的服务和填好的 `token.json`）：

```bash
npm start
# in another shell
npm run live
npm run live:responses
```

不要在 pull request 里把实机脚本指向共享部署。

## Pull requests

- 保持 diff 小、只谈一个主题。
- **PR 里不要有秘密**：不要 `token.json`、不要 `token-*.json`、不要 `.env`、不要露出真实 API key 的 Web 控制台截图、不要带 `Authorization` 头的 CI 日志。
- 即使 git 问起，也不要把 `token.json` 加进提交。该文件已被 gitignore；不要 force-add。
- 不要在未写入 [docs/zh/configuration.md](docs/zh/configuration.md) 和 `.env.example` 的情况下引入新环境变量。
- 不要文档化或提交私有主机名、集群 IP，或其他人的邮箱。
- 保持现有 CommonJS 风格。`npm test` 必须保持绿色。

## 不要发这些

- Cursor 专有 `app.asar` / workbench 包的拷贝。
- 收割来的第三方凭据。
- 「绕过地理限制」或「无限额度」补丁。
- 把运维内部字段重新放到公开 `GET /health` 上的改动。

## 协议备注

Sand 聊天的默认上游是 `aiserver.v1.InferenceService/Stream`。`agent.v1.AgentService/Run` 会拒绝 sand JWT（`Sand traffic is not supported`）。官方 `crsr_` 密钥走 `@cursor/sdk`，不是 `api.cursor.com` 上伪造的 OpenAI URL。见 [docs/zh/advanced/reverse-engineering.md](docs/zh/advanced/reverse-engineering.md)。

## 许可证

本项目是 [AGPL-3.0-or-later](./LICENSE)。提交 PR 即表示你的贡献按同一许可证授权。
