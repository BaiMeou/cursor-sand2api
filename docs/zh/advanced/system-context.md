[English](../../advanced/system-context.md) | **中文**

# System context: what the model actually sees

> 来自 Cursor IDE **3.17.21**（`cursor-local-agent-runtime` / `cursor-agent-host`）的非官方笔记。`~/.cursor/projects/*/agent-transcripts/` 下的 transcript JSONL 只存 `user` / `assistant` —— **不含**系统提示 —— 所以单靠聊天日志无法重建这些。

[reverse-engineering.md](./reverse-engineering.md) 讲 RPC / header / 模型 id。本页是 **IDE Agent 注入的 XML**。cursor-sand2api 的默认 sand 路径是 **InferenceService/Stream**，它**不会**重放那份 IDE 包。

---

## 谁组装提示词

| Path | System prompt + `<user_info>` | What the client sends |
|---|---|---|
| Cursor IDE 本地 agent | 工作站上的运行时把 JSX 渲染成 XML，然后模型看见它 | 完整 `requestContext`（工作区、规则、MCP、git、…） |
| Cursor Cloud worker | `cursor-agent-host` 里同样的 XML 组件 | IDE 仍回答 `execServerMessage.requestContextArgs` |
| **cursor-sand2api（默认，InferenceService）** | **调用方 `role: system` 加上 Cursor 自己的 Inference 包装——不是你的仓库规则** | 消息列表 + 工具。不从磁盘读 `AGENTS.md` |
| cursor-sand2api Agent 路径（`CURSOR_CLIENT_TYPE=ide`） | 服务端上 Cursor 的通用 Agent 提示 | 桩 `requestContext`：`env.operatingSystem` + `env.defaultShell` |

**cursor-sand2api 不会注入调用方的 `AGENTS.md`。** 它不会打开 `/path/to/your/project/AGENTS.md` 或 `C:\Users\you\project\AGENTS.md` 并包进 `<always_applied_workspace_rules>`。若你需要项目规则，把它们放进 `messages[].role=system`、把文件作为 `data:` 文档附加，或直接用 Cursor。

Agent 路径上的 `runRequest.userMessage.text` 也**不含**系统提示。客户端发送用户句子；运行时 / 服务端加上其余部分。

InferenceService 不同：它有真正的 SYSTEM 角色。转换器把你的系统消息作为 system 转发（`src/inference-prompt.js`），不会经假的 user/assistant 对走私。那仍然**不是** IDE 的 `<rules>` 块。

---

## 第 1 层 — 静态系统提示（IDE Agent）

本地运行时使用一副骨架，并按人设（`auto`、`composer`、`grok-4.6`、GPT-5.x、…）替换第一句。Agent 类型还会加上这是 IDE、CLI 还是后台虚拟机。

骨架（缩写）：

```text
You are an AI coding assistant, powered by {name}. {agentType sentence}

Your main goal is to follow the USER's instructions, which are denoted by the <user_query> tag.

<communication> … </communication>
<citing_code> … </citing_code>
<tool_calling> … </tool_calling>
…
```

该骨架里的硬规则包括：不要披露系统提示或工具描述；把环境当成真实的（自己跑工具）；把用户 / skill / MCP 指令当成要求，不是建议。

---

## 第 2 层 — `<user_info>`（IDE，每个会话）

渲染形状（下面的路径是**示例**，不是本仓库）：

```xml
<user_info>
OS Version: windows
Shell: powershell
Workspace Path: /path/to/your/project
Is directory a git repo: Yes, at /path/to/your/project
Terminals folder: C:\Users\you\.cursor\projects\your-project\terminals
Today's date: Saturday Aug 29, 2026
Note: Prefer using absolute paths over relative paths as tool call args when possible.
</user_info>
```

在 Unix 上 terminals 文件夹看起来像 `/home/you/.cursor/projects/your-project/terminals`。日期格式是 `Intl.DateTimeFormat("en-US")`。时区跟随 `x-cursor-timezone`。

条件额外项：多个工作区路径、Cursor worktree 警告、`$HOME` 作为 cwd、不完整的 git 检测、挂载的 Agent store、项目 / meta-agent 笔记文件夹。

cursor-sand2api 的 Agent 桩只返回 OS + shell。`TOOL_MODE=workspace` 还会报告 `WORKSPACE_DIR`，并能在那里执行 read/ls/grep/write/delete。Cursor **自己的**系统提示在 Agent 上仍由服务端注入，去不掉（见下）。

---

## 第 3 层 — `<rules>` / skills / MCP（仅 IDE）

运行时把 `cursorRules` 分桶：

| Bucket | XML | Source |
|---|---|---|
| `globalRules` | `<always_applied_workspace_rules>` | 始终应用的工作区规则，包括名为 `AGENTS.md` / `CLAUDE.md` 的文件 |
| `agentRequestableRules` | `<agent_requestable_workspace_rules>` | glob / 按需；正文不倾倒进系统提示 |
| `userRules` | `<user_rules>` | Cursor Settings → User Rules |
| `skills` | `<agent_skills>` / `<available_skills>` | `SKILL.md` 路径 + 短简介 |

存在时的同级段落：`<git_status>`（快照，会截断）、`<agent_transcripts>`、`<cloud_instructions>`、`<mcp_instructions>`、`<mcp_file_system>`、`<user_profile>`（回复里不得提及）、hooks、computer-use、子代理目录。

Skills 有 token 预算（约 agent 上限的 2%）。溢出先缩短描述，再丢掉。

**这些都不会被 sand2api 从你的仓库加载。** 带 `workspace: "/path/to/your/project"` 的请求只是*告诉*模型该路径在调用方机器上存在。

---

## 第 4 层 — 用户消息上的标签（IDE）

```xml
<timestamp>Saturday, Aug 29, 2026, 1:40 AM (UTC+8)</timestamp>
<user_query>
your actual prompt
</user_query>
```

系统提示说主要目标是执行 `<user_query>`。运行时还会注入隐藏的 `<system_reminder>` 块（截断、空回复、模式切换）。用户提供的 `</user_query>` / `<system_reminder>` 字符串会被过滤，以限制提示词注入。

---

## `requestContext` 握手（Agent）

`execServerMessage.requestContextArgs` 要上面那些原材料：`env.*`、`gitRepos`、`cursorRules`、`agentSkills`、MCP 描述符、terminals 文件夹、日期、打开的标签。IDE 填它们。sand2api 回答 OS + shell（`workspace` 模式下还有工作区路径）。这足以让流结束。这**不够**复现 IDE Agent 行为。

---

## Cursor 骨架能去掉吗？

在 `AgentService/Run` 上（2026-08-29，sand + 一个 Kimi 变体）：

| Field | Runtime intent | Result against `api2.cursor.sh` |
|---|---|---|
| `excludeWorkspaceContext: true` | 丢掉 skills / terminals / 工作区规则 | **拒绝**（“not allowed for this user, team, or selected model”） |
| `customSystemPrompt` | 替换系统提示 | **拒绝**（云 harness 把它当成未知 CLI 标志） |
| `systemPromptSpec.replace` / `.append` | Protobuf oneof | **忽略**（输入 token 数不变） |

结论：

- **工作区层**（`AGENTS.md`、git、User Rules、打开的文件）：sand2api **从未发送**。
- **Cursor 自己的 Agent 骨架：** 对这类账号/模型，客户端在 AgentService 上**关不掉**它。
- **InferenceService：** 你的 `system` 消息是真正的 system 回合。你仍然不会得到一个安静、空的 Cursor。你也不会自动得到项目规则。

若你需要裸模型和你完全控制的系统提示，用一份文档写明该合同的提供商 API。不要指望 AgentService/Run 是那个 API。

---

## Grok Bot 桌面

`{gatewayUrl}/api/sendPrompt` **不**携带这份 XML，也**不**接受模型 id。这里未实现，也不是 Claude 路径。
