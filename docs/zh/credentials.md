[English](../credentials.md) | **中文**

# 凭据

cursor-sand2api 从不替你登录 Cursor。它只**复用你已经拥有的凭据**：来自本机 Cursor 安装的 sand IDE JWT，和/或来自 Cursor 控制台的官方 User API Key（`crsr_…`）。

两种都放在同一个 JSON 文件里（默认 `./token.json`）。若该文件缺失或没有可用条目，进程会在启动时**退出**。文件会被监视，变更时重新加载。

**永远不要提交 `token.json`。** 复制 [token.json.example](../../token.json.example)。`.gitignore` 已经排除 `token.json`、`token-*.json` 和 `token-disabled.json`。

## 两种类型

| `kind` | Fields | Upstream | Public model ids |
|---|---|---|---|
| `sand`（默认） | `accessToken` + `machineId` + 可选 `macMachineId` | Cursor ConnectRPC。**聊天默认是 `aiserver.v1.InferenceService/Stream`。** `agent.v1.AgentService/Run` 会拒绝 sand JWT（`Sand traffic is not supported`）。 | 不带前缀的家族名（`kimi-k3`、`claude-4.5-sonnet`、…） |
| `api` | 以 `crsr_` 开头的 `apiKey` | 官方 [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk)（`Agent.create` + `send`）。Cursor 官方 REST **不**暴露 `/v1/chat/completions`；SDK 才是受支持的官方路径。 | 同样的名字加上 `api-` 前缀（`api-kimi-k3`、`api-composer-2.5`） |

你可以在一个文件里混用两个数组。转换器会挑一条 **kind** 与请求 id 匹配的凭据（`api-*` → 官方池，否则 sand），且该账号的目录里仍列有该模型。

Grok Bot 桌面聊天（`GrokBotService/EnsureSandBox` 然后 `{gatewayUrl}/api/sendPrompt`）**没有接线**。`sendPrompt` **没有 model 字段**，无法选择 Claude（或任何其它命名模型）。不要把那个 Bot 网关当成 Claude 路径。

## Schema（`token.json.example`）

```json
{
  "tokens": [
    {
      "name": "sand-ultra",
      "kind": "sand",
      "accessToken": "your-cursor-access-token-here",
      "machineId": "your-machine-id-here",
      "macMachineId": "your-mac-machine-id-here"
    },
    {
      "name": "official-sdk",
      "kind": "api",
      "apiKey": "crsr_your-cursor-user-api-key-here"
    }
  ]
}
```

规则：

- `name` 是日志用的本地标签。它**不会**出现在公开错误 JSON 里。
- 没有真实 `accessToken`（或仍是示例占位符）的 sand 条目会被跳过。
- 若 `kind` 为 `api` / `official` / `crsr`，或 `apiKey` / `key` 以 `crsr_` 开头，则识别为官方条目。
- 也接受顶层对象数组（`[{ ... }, ...]`）。
- `TOKEN_FILE` 覆盖路径（见 [配置](./configuration.md)）。

在 [cursor.com/dashboard/api](https://cursor.com/dashboard/api) 创建官方密钥。只粘贴你自己拥有的密钥。

## `npm run token`

从本机已安装、已登录的 Cursor 导入 **sand** JWT。需要 **Node 22.5+**（`node:sqlite`）。HTTP 服务本身在 Node 18.18+ 上运行。

```bash
npm run token
```

脚本打开 Cursor 的 `state.vscdb`（若 Cursor 持有写锁，它会把 db + WAL 复制到临时文件再读），读取 `cursorAuth/accessToken`，再从同级的 `storage.json` 读取 `telemetry.machineId` / `telemetry.macMachineId`。它**合并**进 `token.json`：已有账号保留；相同 `name` 或相同 `accessToken` 会被替换。文件写成模式 `0600`。

它打印账号标签、若存在则打印套餐字符串、过期时间，以及一段短的机器 id 前缀。**它不打印 token。**

### 标志

| Flag | Meaning |
|---|---|
| `--print` | 只显示标签 / 过期 / 机器前缀。什么都不写。 |
| `--force` | 若输出文件存在但不是合法 JSON，替换它而不是退出。 |
| `--name <label>` | 存在这个 `name` 下（默认：缓存邮箱，否则 `cursor-ide`）。 |
| `--out <path>` | 写到该文件而不是 `./token.json`。 |
| `--db <path>` | 使用这个 `state.vscdb`（便携安装、额外配置）。`storage.json` 取自同一目录。 |
| `--help` / `-h` | 用法。 |

示例：

```bash
npm run token -- --print
npm run token -- --name work --out ./token-work.json
npm run token -- --db /path/to/Cursor/User/globalStorage/state.vscdb
```

### Cursor 把 JWT 存在哪

默认配置 `User/globalStorage`：

| OS | Directory |
|---|---|
| Windows | `%APPDATA%\Cursor\User\globalStorage\`（`state.vscdb`、`storage.json`） |
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/` |
| Linux | `$XDG_CONFIG_HOME/Cursor/User/globalStorage/` 或 `~/.config/Cursor/User/globalStorage/`（也有 `~/.cursor/`） |

至少在 Cursor 应用里登录一次。便携安装可以在任何地方——传 `--db`。

Grok Bot 自己加密的 `sand-secrets.json` 是**另一种** token。不要把它粘进 `accessToken`。

## Checksum

Sand 请求发送 `x-cursor-checksum`：一段按时间搅乱的 6 字节前缀（XOR 链，种子 165，base64），加上 `machineId` 和可选的 `/macMachineId`。错误的机器 id 会造成看起来像死 JWT 的鉴权失败。`npm run token` 会从签发该 JWT 的同一个 Cursor 配置填入两个 id。

## 轮换与卫生

- 再次登录 Cursor 后重新跑 `npm run token`（JWT 过期是 `exp` claim）。
- 在控制台吊销泄露的 `crsr_` 密钥；从 `token.json` 删掉那个对象。
- `token-disabled.json`（与 `TOKEN_FILE` 同级）是转换器在某条凭据上停止提供的模型本地缓存（额度 / 套餐）。它已被 gitignore。删掉它只会刷新目录，不会恢复 Cursor 额度。
- 不要把 `token.json` 放在共享卷或容器镜像里。

下一步：[配置](./configuration.md) · [部署](./deployment.md)
