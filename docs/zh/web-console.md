[English](../web-console.md) | **中文**

# Web 控制台

进程可以从 `public/` 在 `/` 提供一个小型聊天 UI。**没有构建步骤**、没有 CDN、没有前端 npm 依赖。界面语言已经是 **zh-CN**（`<html lang="zh-CN">`）。文案和按钮本身就是中文；本页是该 UI 的中文说明。

页面只和**本**转换器说话：`/v1/models`、`/v1/chat/completions`、`/health` 和 `/health/detail`。它不知道 Cursor RPC 或 `token.json`。

## 何时提供

`WEB_UI` 对照 `HOST` 解析（见 [配置](./configuration.md)）：

| Bind | Unset `WEB_UI` | Explicit |
|---|---|---|
| `127.0.0.1` / `::1` / `localhost` | **on** | `WEB_UI=off` 关掉它 |
| 任何其它地址 | **off** | `WEB_UI=on` 强制 **on** —— 不要在公网 IP 上这么做 |

UI 关掉时，`/` 是 404。`/v1/*` 不变。

**不要把这个控制台暴露在 `0.0.0.0`。** 它是无需鉴权的静态文件。任何能加载该页、并能猜到或偷到 `API_KEY` 的人（或经隧道打到回环空密钥设置的人）都会消耗**你的** Cursor 额度。在服务器上设 `WEB_UI=off`；若要 UI，再跑一份本地副本。

## localStorage

所有状态都在浏览器里，键为：

```text
sand2api.state.v1
```

该对象保存转换器 API key、Base URL 覆盖、主题、模型、参数面板和会话列表（含暂存附件）。清除站点数据会让你退出控制台；它不会吊销 Cursor 凭据。

UI 没有服务端会话。

## 设置

第一次打开时，把 **API Key** 填成与进程 `API_KEY` 相同的值（例如 `changeme`）。调用会发送 `Authorization: Bearer …`。若服务端密钥为空（仅回环），该字段可以留空。

可选 Base URL 默认是页面 origin，所以 `http://127.0.0.1:13000` 直接就能用。

## 健康

侧栏徽章调用 **`GET /health`**（公开）：`status`、`version`，以及 `tokens.total` / `tokens.healthy`。这足以显示 “ok · 2/2”。

设置面板的原始 JSON 在配置了 API key 时使用 **`GET /health/detail`**，这样运维能看到工具模式、超时和打码后的用量，而不把那些字段放在公开探测上。没有密钥时，面板回退到公开 `/health` body。

不要把 `/health/detail` 截图进 GitHub issue。

## 功能

- 流式聊天；思考折叠为「思考过程」；停止按钮
- 从 `/v1/models` 选模型（上下文窗口、图片、思考）。目录里没有的名字会被标记但仍可选——列出 ≠ 权益
- 图片和文档附件（点击 / 拖放 / 粘贴），路径与 HTTP API 相同
- 多个会话持久化在 `sand2api.state.v1`
- 系统提示、`max_tokens`、temperature、reasoning effort、JSON 模式、stop 序列
- 每回合用量和浅色/深色主题

`npm run ui` 是可选的无头冒烟（经 CDP 用系统 Chrome/Edge，没有 Playwright）。若指向实机服务会消耗额度。

## 文件

```text
public/index.html
public/app.css
public/app.js
public/markdown.js
```

编辑后刷新。没有打包器。
