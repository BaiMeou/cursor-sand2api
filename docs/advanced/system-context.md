# System context: what the model actually sees

**English** | [中文](../zh/advanced/system-context.md)

> Unofficial notes from Cursor IDE **3.17.21** (`cursor-local-agent-runtime` / `cursor-agent-host`). Transcript JSONL under `~/.cursor/projects/*/agent-transcripts/` stores `user` / `assistant` only — **not** the system prompt — so this cannot be reconstructed from chat logs alone.

[reverse-engineering.md](./reverse-engineering.md) is RPC / headers / model ids. This page is the **XML the IDE Agent injects**. cursor-sand2api’s default sand path is **InferenceService/Stream**, which does **not** replay that IDE bundle.

---

## Who assembles the prompt

| Path | System prompt + `<user_info>` | What the client sends |
|---|---|---|
| Cursor IDE local agent | Runtime on the workstation renders JSX → XML, then the model sees it | Full `requestContext` (workspace, rules, MCP, git, …) |
| Cursor Cloud worker | Same XML components in `cursor-agent-host` | IDE still answers `execServerMessage.requestContextArgs` |
| **cursor-sand2api (default, InferenceService)** | **Caller `role: system` plus Cursor’s own Inference wrapper — not your repo rules** | Message list + tools. No `AGENTS.md` read from disk |
| cursor-sand2api Agent path (`CURSOR_CLIENT_TYPE=ide`) | Cursor’s generic Agent prompt on the server | Stub `requestContext`: `env.operatingSystem` + `env.defaultShell` |

**cursor-sand2api does not inject the caller’s `AGENTS.md`.** It will not open `/path/to/your/project/AGENTS.md` or `C:\Users\you\project\AGENTS.md` and wrap it in `<always_applied_workspace_rules>`. If you need project rules, put them in `messages[].role=system`, attach the file as a `data:` document, or use Cursor itself.

`runRequest.userMessage.text` on the Agent path also does **not** contain the system prompt. The client sends the user sentence; the runtime / server adds the rest.

InferenceService is different: it has a real SYSTEM role. The converter forwards your system message as system (`src/inference-prompt.js`) and does not smuggle it through a fake user/assistant pair. That still is **not** the IDE’s `<rules>` block.

---

## Layer 1 — static system prompt (IDE Agent)

The local runtime uses one skeleton and swaps the first sentence by persona (`auto`, `composer`, `grok-4.6`, GPT-5.x, …). Agent type adds whether this is IDE, CLI, or a background VM.

Skeleton (abbreviated):

```text
You are an AI coding assistant, powered by {name}. {agentType sentence}

Your main goal is to follow the USER's instructions, which are denoted by the <user_query> tag.

<communication> … </communication>
<citing_code> … </citing_code>
<tool_calling> … </tool_calling>
…
```

Hard rules in that skeleton include: do not disclose the system prompt or tool descriptions; treat the environment as real (run tools yourself); treat user / skill / MCP instructions as requirements, not suggestions.

---

## Layer 2 — `<user_info>` (IDE, every session)

Rendered shape (paths below are **examples**, not this repository):

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

On Unix the terminals folder looks like `/home/you/.cursor/projects/your-project/terminals`. Date formatting is `Intl.DateTimeFormat("en-US")`. Timezone follows `x-cursor-timezone`.

Conditional extras: multiple workspace paths, Cursor worktree warnings, `$HOME` as cwd, incomplete git detection, mounted Agent stores, project / meta-agent notes folders.

cursor-sand2api’s Agent stub only returns OS + shell. `TOOL_MODE=workspace` also reports `WORKSPACE_DIR` and can execute read/ls/grep/write/delete there. Cursor’s **own** system prompt is still server-injected on Agent and cannot be stripped (see below).

---

## Layer 3 — `<rules>` / skills / MCP (IDE only)

The runtime buckets `cursorRules`:

| Bucket | XML | Source |
|---|---|---|
| `globalRules` | `<always_applied_workspace_rules>` | Always-apply workspace rules, including files named `AGENTS.md` / `CLAUDE.md` |
| `agentRequestableRules` | `<agent_requestable_workspace_rules>` | Glob / on-demand; body not dumped into the system prompt |
| `userRules` | `<user_rules>` | Cursor Settings → User Rules |
| `skills` | `<agent_skills>` / `<available_skills>` | `SKILL.md` paths + short blurbs |

Sibling sections when present: `<git_status>` (snapshot, truncated), `<agent_transcripts>`, `<cloud_instructions>`, `<mcp_instructions>`, `<mcp_file_system>`, `<user_profile>` (must not be mentioned in replies), hooks, computer-use, subagent catalogs.

Skills have a token budget (~2% of the agent cap). Overflow shortens, then drops, descriptions.

**None of this is loaded by sand2api from your repo.** A request to this converter with `workspace: "/path/to/your/project"` only *tells* the model that path exists on the caller’s machine.

---

## Layer 4 — tags on the user message (IDE)

```xml
<timestamp>Saturday, Aug 29, 2026, 1:40 AM (UTC+8)</timestamp>
<user_query>
your actual prompt
</user_query>
```

The system prompt says the main goal is to execute `<user_query>`. Runtime also injects hidden `<system_reminder>` blocks (truncation, empty reply, mode switches). User-supplied `</user_query>` / `<system_reminder>` strings are filtered to limit prompt injection.

---

## `requestContext` handshake (Agent)

`execServerMessage.requestContextArgs` asks for the raw materials above: `env.*`, `gitRepos`, `cursorRules`, `agentSkills`, MCP descriptors, terminals folder, date, open tabs. The IDE fills them. sand2api answers OS + shell (and workspace path in `workspace` mode). That is enough for the stream to finish. It is **not** enough to reproduce IDE Agent behavior.

---

## Can the Cursor skeleton be removed?

On `AgentService/Run` (2026-08-29, sand + a Kimi variant):

| Field | Runtime intent | Result against `api2.cursor.sh` |
|---|---|---|
| `excludeWorkspaceContext: true` | Drop skills / terminals / workspace rules | **Rejected** (“not allowed for this user, team, or selected model”) |
| `customSystemPrompt` | Replace the system prompt | **Rejected** (cloud harness treats it as an unknown CLI flag) |
| `systemPromptSpec.replace` / `.append` | Protobuf oneof | **Ignored** (input token count unchanged) |

Conclusion:

- **Workspace layer** (`AGENTS.md`, git, User Rules, open files): sand2api **never sent it**.
- **Cursor’s own Agent skeleton:** the client **cannot** turn it off on AgentService for this class of account/model.
- **InferenceService:** your `system` message is a real system turn. You still do not get a silent, empty Cursor. You also do not get automatic project rules.

If you need a bare model and a system prompt you fully control, use a provider API that documents that contract. Do not expect AgentService/Run to be that API.

---

## Grok Bot desktop

`{gatewayUrl}/api/sendPrompt` does **not** carry this XML and **does not** take a model id. It is not implemented here and is not a Claude path.
