const { v4: uuidv4 } = require("uuid");
const { parseTextToolCalls } = require("./tool-parse");

const MCP_PROVIDER = "openai";

// McpArgs.args is map<string, bytes> in the proto, and over connect+proto each
// value is a serialized google.protobuf.Value. This client speaks connect+json,
// where the server hands the arguments back as natural JSON instead — verified
// 2026-08-30 against api2.cursor.sh: {"city":"Osaka","opts":{"units":"celsius"}}.
// Base64-decoding those would turn "Osaka" into ":\u01a4".
function decodeMcpArgs(args) {
  if (!args || typeof args !== "object") return {};
  return { ...args };
}

const BUILTIN_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file on the local machine. Path is absolute or workspace-relative.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", description: "1-based start line" },
          limit: { type: "integer", description: "max lines" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a file on the local machine. Creates parent directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          contents: { type: "string" },
        },
        required: ["path", "contents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List a directory tree on the local machine.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents with a regex on the local machine.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string" },
          glob: { type: "string" },
          case_insensitive: { type: "boolean" },
          head_limit: { type: "integer" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file on the local machine.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command on the local machine. cwd is the workspace unless working_directory is set.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          working_directory: { type: "string" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "HTTP GET a public URL and return text.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
];

function customToolNames(tools) {
  const builtin = new Set(BUILTIN_TOOLS.map((t) => t.function.name));
  const names = [];
  for (const t of tools || []) {
    const n = t.function?.name || t.name;
    if (n && !builtin.has(n)) names.push(t);
  }
  return names;
}

function requestToolNames(tools) {
  const names = new Set();
  for (const t of tools || []) {
    const n = t.function?.name || t.name;
    if (n) names.add(n);
  }
  return names;
}

// Cursor runs its own builtins under these names and rejects the whole request
// when a declared tool claims one. Claude Code ships exactly such a tool set
// (Read, Write, WebSearch, WebFetch), so colliding names travel suffixed and
// are mapped back before the caller ever sees them.
const CURSOR_BUILTIN_TOOL_NAMES = new Set([
  "read",
  "write",
  "ls",
  "delete",
  "grep",
  "glob",
  "shell",
  "web_search",
  "web_fetch",
]);

function normalizeToolName(name) {
  return String(name || "")
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")
    .toLowerCase()
    .replace(/-/g, "_");
}

function toolNameMap(tools) {
  const declared = [];
  for (const t of tools || []) {
    const n = t.function?.name || t.name;
    if (n) declared.push(n);
  }
  const taken = new Set(declared);
  const toWire = new Map();
  const fromWire = new Map();
  const byNormalized = new Map();

  for (const name of declared) {
    let wire = name;
    while (CURSOR_BUILTIN_TOOL_NAMES.has(normalizeToolName(wire)) || (wire !== name && taken.has(wire))) {
      wire += "_";
    }
    taken.add(wire);
    toWire.set(name, wire);
    fromWire.set(wire, name);
    byNormalized.set(normalizeToolName(name), name);
  }

  return {
    wire: (name) => toWire.get(name) || name,
    // Models paraphrase: they drop the suffix, or send websearch for WebSearch.
    caller(name) {
      if (fromWire.has(name)) return fromWire.get(name);
      if (toWire.has(name)) return name;
      for (const candidate of [name, String(name || "").replace(/_+$/, "")]) {
        const hit = byNormalized.get(normalizeToolName(candidate));
        if (hit) return hit;
      }
      return name;
    },
    size: toWire.size,
  };
}

const IDENTITY_TOOL_NAMES = toolNameMap([]);

// Caller functions declared as McpToolDefinition so the model gets real Cursor
// tool calls instead of the invoke_client_tool text marker.
function buildMcpToolDefinitions(tools, names = toolNameMap(tools)) {
  const out = [];
  for (const t of tools || []) {
    const fn = t.function || t;
    if (!fn || !fn.name) continue;
    const wire = names.wire(fn.name);
    out.push({
      name: wire,
      toolName: wire,
      providerIdentifier: MCP_PROVIDER,
      description: fn.description || "",
      inputSchemaJson: JSON.stringify(fn.parameters || { type: "object", properties: {} }),
    });
  }
  return out;
}

const BUILTIN_TOOL_NAMES = BUILTIN_TOOLS.map((t) => t.function.name);

// nativeToolCalls: the caller's functions are registered upstream as MCP tools,
// so the invoke_client_tool text protocol must NOT be advertised. Offering both
// makes the model pick one at random and half the calls come back as prose.
function extraToolsPrompt(openaiTools, workspace, nativeToolCalls = false, webSearch = false) {
  const names = requestToolNames(openaiTools);
  const extra = customToolNames(openaiTools);
  // The forbidden list has to stay in step with what the runtime actually
  // refuses. Naming WebSearch here while web access is on had the model
  // dutifully answering "no web access" on a turn that could have searched.
  const forbidden = [
    "Shell",
    "Read",
    "ReadFile",
    "Grep",
    "Write",
    "StrReplace",
    "Delete",
    "LS",
    "Glob",
    "Git",
    "MCP",
    "Subagent",
    "ComputerUse",
    "diagnostics",
  ];
  if (!webSearch) forbidden.splice(9, 0, "WebFetch", "WebSearch");

  const lines = [];

  if (names.size) {
    lines.push(
      "HARD RULE — only the CLIENT TOOLS listed below exist on this turn.",
      `You MUST NOT use Cursor built-in agent tools: ${forbidden.join(", ")}, or any terminal/filesystem tool.`,
      `You MUST NOT call these built-ins unless the exact name is listed under CLIENT TOOLS: ${BUILTIN_TOOL_NAMES.join(", ")}.`,
      "Built-in calls are rejected. Do not retry them. Do not ask the user to run them."
    );
    if (webSearch) {
      lines.push("WebSearch and WebFetch ARE available. Use them when the answer depends on current information.");
    }
  } else if (webSearch) {
    lines.push(
      "This turn has no editor, no filesystem and no terminal.",
      "WebSearch and WebFetch ARE available — use them when the answer depends on current information. Every other tool call is rejected.",
      "Otherwise answer in plain text, and do not ask the user to run anything for you."
    );
  } else {
    // Naming the exec builtins is actively harmful with no CLIENT TOOLS section
    // to qualify them: the model reads the list as an inventory of what it has,
    // the closing line then tells it there are no tools, and the contradiction
    // is what it answers instead of the question. Observed on claude-4.5-haiku,
    // which spent a whole turn asking whether it was being tested.
    lines.push(
      "HARD RULE — this turn has no editor, no filesystem and no terminal: every tool call is rejected before it runs.",
      "Answer in plain text. Do not call a tool, do not describe calling one, and do not ask the user to run anything for you."
    );
  }

  if (workspace) {
    lines.push(`User workspace root (context only, you cannot read it): ${workspace}`);
  }
  if (names.size) {
    lines.push("CLIENT TOOLS — the ONLY functions you may call. They run on the user's computer.");
    // Native Inference/MCP already carries JSON Schema on the request. Dumping
    // every parameters object into the system prompt (Claude Code sends ~90)
    // crowds out the user turn and the model answers with tool_calls + empty
    // content. Keep the inventory; leave the schema on the wire.
    lines.push(
      ...[...openaiTools]
        .map((t) => {
          const fn = t.function || t;
          if (!fn?.name) return "";
          if (nativeToolCalls) {
            return fn.description ? `- ${fn.name}: ${fn.description}` : `- ${fn.name}`;
          }
          return `- ${fn.name}: ${fn.description || ""}\n  parameters: ${JSON.stringify(fn.parameters || {})}`;
        })
        .filter(Boolean)
    );
    if (nativeToolCalls) {
      lines.push(
        "CLIENT TOOLS are registered with your runtime. Call them the normal way.",
        "Never describe a tool call in prose and never emit invoke_client_tool.",
        "After the tool result arrives, write a user-visible answer in the assistant body."
      );
    } else if (extra.length) {
      lines.push(
        "To call a CLIENT TOOL, emit exactly one line:",
        'invoke_client_tool {"name":"<one of CLIENT TOOLS>","arguments":{...}}',
        "After tool_result arrives, write a user-visible answer in the assistant body."
      );
    }
    lines.push("If a CLIENT TOOL can do the job, call it. Never substitute a Cursor built-in.");
  }
  return `<client_runtime>\n${lines.join("\n")}\n</client_runtime>\n\n`;
}

// Sand Claude has no Cursor builtin tools on the wire. Only advertise the
// caller's functions and the one-line invoke format — nothing about the
// converter or Shell/Read/Grep, so the user's own system stays the main prompt.
function textToolsPrompt(openaiTools, toolChoice) {
  const items = [];
  for (const t of openaiTools || []) {
    const fn = t && (t.function || t);
    if (!fn || !fn.name) continue;
    const desc = fn.description ? `: ${fn.description}` : "";
    const params =
      fn.parameters && typeof fn.parameters === "object" ? JSON.stringify(fn.parameters) : "{}";
    items.push(`- ${fn.name}${desc}\n  parameters: ${params}`);
  }
  if (!items.length) return "";
  const lines = [
    "Functions:",
    ...items,
    "Call with Anthropic XML:",
    "<function_calls>",
    '<invoke name="NAME">',
    '<parameter name="KEY">VALUE</parameter>',
    "</invoke>",
    "</function_calls>",
    "Do not invent other call formats. After results, answer the user in plain text.",
  ];
  if (toolChoice === "required") lines.push("Call a function before answering.");
  else if (toolChoice && toolChoice !== "auto" && toolChoice !== "none") {
    const name = typeof toolChoice === "string" ? toolChoice : "";
    if (name) lines.push(`Call ${name} before answering.`);
  }
  return `${lines.join("\n")}\n\n`;
}

function parseClientToolLine(text, options) {
  return parseTextToolCalls(text, options);
}

function execToToolCall(exec, names = IDENTITY_TOOL_NAMES) {
  const id = `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
  const call = { id, type: "function", function: { name: "", arguments: "{}" }, _exec: exec };

  const read = exec.readArgs || exec.redactedReadArgs || exec.piReadArgs;
  if (read) {
    call.function.name = "read_file";
    call.function.arguments = JSON.stringify({
      path: read.path,
      offset: read.offset,
      limit: read.limit,
    });
    call._resultKey = exec.redactedReadArgs ? "redactedReadResult" : "readResult";
    return call;
  }
  const ls = exec.lsArgs || exec.piLsArgs;
  if (ls) {
    call.function.name = "list_dir";
    call.function.arguments = JSON.stringify({ path: ls.path || "." });
    call._resultKey = "lsResult";
    return call;
  }
  const grep = exec.grepArgs || exec.piGrepArgs || exec.piFindArgs;
  if (grep) {
    call.function.name = "grep";
    call.function.arguments = JSON.stringify({
      pattern: grep.pattern,
      path: grep.path,
      glob: grep.glob,
      case_insensitive: grep.caseInsensitive,
      head_limit: grep.headLimit,
      output_mode: grep.outputMode,
    });
    call._resultKey = "grepResult";
    return call;
  }
  const write = exec.writeArgs || exec.piWriteArgs;
  if (write) {
    call.function.name = "write_file";
    call.function.arguments = JSON.stringify({
      path: write.path,
      contents: write.fileText || "",
    });
    call._resultKey = "writeResult";
    return call;
  }
  if (exec.deleteArgs) {
    call.function.name = "delete_file";
    call.function.arguments = JSON.stringify({ path: exec.deleteArgs.path });
    call._resultKey = "deleteResult";
    return call;
  }
  const shell = exec.shellArgs || exec.shellStreamArgs || exec.piBashArgs || exec.miniSweAgentBashArgs;
  if (shell) {
    call.function.name = "shell";
    call.function.arguments = JSON.stringify({
      command: shell.command || (shell.simpleCommands || []).join(" && "),
      working_directory: shell.workingDirectory,
    });
    call._resultKey = "shellResult";
    return call;
  }
  if (exec.fetchArgs) {
    call.function.name = "web_fetch";
    call.function.arguments = JSON.stringify({ url: exec.fetchArgs.url });
    call._resultKey = "fetchResult";
    return call;
  }
  if (exec.gitDiffRequest) {
    call.function.name = "shell";
    call.function.arguments = JSON.stringify({ command: "git diff" });
    call._resultKey = "gitDiffResponse";
    return call;
  }
  if (exec.mcpArgs) {
    const mcp = exec.mcpArgs;
    call.function.name = names.caller(mcp.toolName || mcp.name || "mcp_tool");
    call.function.arguments = JSON.stringify(decodeMcpArgs(mcp.args));
    if (mcp.toolCallId) call.id = String(mcp.toolCallId);
    call._resultKey = "mcpResult";
    return call;
  }
  return null;
}

function parseToolContent(content) {
  if (content == null) return {};
  if (typeof content === "object") return content;
  const s = String(content);
  try {
    return JSON.parse(s);
  } catch {
    return { text: s };
  }
}

function toolResultToExecPayload(call, content) {
  const key = call._resultKey;
  const data = parseToolContent(content);
  const err = data.error || data.rejected;
  const path = data.path || "";

  if (key === "readResult" || key === "redactedReadResult") {
    if (err || data.fileNotFound) return { fileNotFound: { path: path || data.fileNotFound?.path || "" } };
    const text = data.content || data.text || (typeof content === "string" ? content : JSON.stringify(data));
    const lines = String(text).split(/\r?\n/);
    return {
      success: {
        path: path || JSON.parse(call.function.arguments || "{}").path || "",
        content: text,
        totalLines: lines.length,
        fileSize: String(Buffer.byteLength(String(text))),
        truncated: false,
        rangeApplied: false,
      },
    };
  }
  if (key === "lsResult") {
    if (err) return { error: { path, error: String(err) } };
    if (data.success) return { success: data.success };
    const entries = data.entries || data.files || [];
    const childrenFiles = (Array.isArray(entries) ? entries : String(data.text || "").split("\n").filter(Boolean)).map(
      (e) => ({ name: typeof e === "string" ? e : e.name })
    );
    return {
      success: {
        directoryTreeRoot: {
          absPath: path || ".",
          childrenDirs: data.dirs || [],
          childrenFiles,
          childrenWereProcessed: true,
          fullSubtreeExtensionCounts: {},
          numFiles: childrenFiles.length,
        },
      },
    };
  }
  if (key === "grepResult") {
    if (err) return { error: { error: String(err) } };
    if (data.success) return { success: data.success };
    const files = data.files || data.entries || [];
    const root = path || ".";
    return {
      success: {
        pattern: data.pattern || "",
        path: root,
        outputMode: "files_with_matches",
        workspaceResults: {
          [root]: {
            files: {
              files: Array.isArray(files) ? files : [],
              totalFiles: Array.isArray(files) ? files.length : 0,
              clientTruncated: false,
              ripgrepTruncated: false,
            },
          },
        },
      },
    };
  }
  if (key === "writeResult") {
    if (err) return { error: { error: String(err) } };
    return { success: { path: path || JSON.parse(call.function.arguments || "{}").path, linesCreated: 1, fileSize: 0 } };
  }
  if (key === "deleteResult") {
    if (err) return { error: { error: String(err) } };
    return { success: { path, deletedFile: path, fileSize: "0", prevContent: "" } };
  }
  if (key === "shellResult") {
    if (data.rejected) return { rejected: { reason: String(data.rejected) } };
    const stdout = data.stdout != null ? data.stdout : data.text || (typeof content === "string" ? content : "");
    return {
      success: {
        command: data.command || "",
        workingDirectory: data.working_directory || data.cwd || "",
        exitCode: data.exit_code ?? data.exitCode ?? 0,
        signal: "",
        stdout: String(stdout),
        stderr: String(data.stderr || ""),
        executionTime: data.executionTime || 0,
      },
    };
  }
  if (key === "fetchResult") {
    if (err) return { error: { url: data.url || "", error: String(err) } };
    return {
      success: {
        url: data.url || "",
        content: data.content || data.text || String(content),
        statusCode: data.status_code || data.statusCode || 200,
        contentType: data.content_type || "text/plain",
      },
    };
  }
  if (key === "gitDiffResponse") {
    return { success: { diff: data.diff || data.text || String(content) } };
  }
  if (key === "mcpResult") {
    if (err) return { error: { error: String(err) } };
    const text =
      typeof content === "string" ? content : JSON.stringify(data.content ?? data.text ?? data);
    return { success: { content: [{ text: { text } }], isError: false } };
  }
  return { error: { error: "unmapped tool result" } };
}

function toolMessageContent(m) {
  if (typeof m.content === "string") return m.content;
  if (m.content == null) return "";
  return JSON.stringify(m.content);
}

function isToolResultRole(role) {
  return role === "tool" || role === "function";
}

function extractTrailingToolResults(messages) {
  const out = [];
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isToolResultRole(m.role)) break;
    out.unshift({
      tool_call_id: m.tool_call_id || m.toolCallId || m.name,
      content: toolMessageContent(m),
    });
  }
  return out;
}

function extractOpenAIToolResults(messages) {
  return extractTrailingToolResults(messages);
}

function lastAssistantToolCallIds(messages) {
  const ids = [];
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isToolResultRole(m.role)) continue;
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        if (c.id) ids.push(c.id);
      }
    }
    break;
  }
  return ids;
}

// Responses-API-shaped clients send input_text / input_image / input_file, and
// file parts arrive from upload-capable clients. Everything that is not plain
// text is announced rather than dropped, so the model knows something was there.
function contentToText(content, options = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (typeof p === "string") {
      parts.push(p);
      continue;
    }
    if (!p) continue;
    switch (p.type) {
      case "text":
      case "input_text":
      case "output_text":
        if (p.text) parts.push(p.text);
        break;
      case "image_url":
      case "input_image":
        // Attached turns say nothing here: the picture is really going up, and
        // announcing an omission would just contradict it.
        if (!options.imagesAttached) parts.push("[image omitted: converter has no vision upload]");
        break;
      case "input_audio":
        parts.push("[audio omitted]");
        break;
      case "file":
      case "input_file": {
        // Same bargain as images: when the document really is going up, saying
        // it was omitted contradicts the attachment the model can see.
        if (options.documentsAttached) break;
        // Chat-completions nests the payload under `file`; the Responses
        // spelling puts the same keys straight on the part.
        const src = (p.file && typeof p.file === "object" ? p.file : p) || {};
        parts.push(`[file omitted: ${src.filename || src.file_id || "attachment"}]`);
        break;
      }
      case "refusal":
        if (p.refusal) parts.push(`[refused] ${p.refusal}`);
        break;
      default:
        if (p.text) parts.push(p.text);
    }
  }
  return parts.join("\n");
}

function lastUserIndex(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") return i;
  }
  return -1;
}

function lastMessageIsTool(messages) {
  if (!messages || !messages.length) return false;
  return isToolResultRole(messages[messages.length - 1].role);
}

function messagesToPrompt(messages, extraPrefix = "", options = {}) {
  if (!messages || messages.length === 0) return extraPrefix;
  const parts = extraPrefix ? [extraPrefix.trim()] : [];
  // Only the last user turn can carry real attachments; earlier ones stay text.
  const anyAttached = Boolean(options.imagesAttached || options.documentsAttached);
  const attachedAt = anyAttached ? lastUserIndex(messages) : -1;
  if (lastMessageIsTool(messages)) {
    parts.push(
      "<openai_turn>The client already executed your tool calls. Use the tool_result blocks as ground truth and write a user-visible answer now. Do not call tools again unless you still need more data.</openai_turn>"
    );
  }
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const role = msg.role || "user";
    if (isToolResultRole(role)) {
      parts.push(
        `<tool_result tool_call_id="${msg.tool_call_id || msg.name || ""}">\n${toolMessageContent(msg)}\n</tool_result>`
      );
      continue;
    }
    // A turn can attach pictures without attaching documents; each note is
    // suppressed only by its own kind actually being sent.
    const onAttachedTurn = index === attachedAt;
    let content = contentToText(msg.content, {
      imagesAttached: onAttachedTurn && Boolean(options.imagesAttached),
      documentsAttached: onAttachedTurn && Boolean(options.documentsAttached),
    });
    // A refusal is the whole answer for that turn. Dropping it leaves a hole the
    // model reads as the assistant having said nothing.
    if (!content && msg.refusal) content = `[refused] ${msg.refusal}`;
    if (role === "assistant" && msg.reasoning_content) {
      content = `<thinking>\n${msg.reasoning_content}\n</thinking>\n${content || ""}`.trim();
    }
    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      // The ids have to appear here: the results below are tagged with them, and
      // with parallel calls there is no other way to pair the two halves.
      const calls = msg.tool_calls
        .map(
          (c) =>
            `${c.function?.name || c.name || ""}(${c.function?.arguments || ""}) [tool_call_id=${c.id || ""}]`
        )
        .join("\n");
      parts.push(`<assistant_tool_calls>\n${calls}\n${content || ""}\n</assistant_tool_calls>`);
      continue;
    }
    if (!content) continue;
    if (role === "system" || role === "developer") parts.push(`<system>\n${content}\n</system>`);
    else if (role === "assistant") parts.push(`<assistant>\n${content}\n</assistant>`);
    else parts.push(msg.name ? `${msg.name}: ${content}` : content);
  }
  return parts.join("\n\n");
}

function publicToolCall(call, index = 0) {
  return {
    id: call.id,
    type: "function",
    index,
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
  };
}

function mergeToolLists(requestTools) {
  const byName = new Map();
  for (const t of BUILTIN_TOOLS) byName.set(t.function.name, t);
  for (const t of requestTools || []) {
    const fn = t.function || t;
    if (!fn?.name) continue;
    byName.set(fn.name, t.type ? t : { type: "function", function: fn });
  }
  return [...byName.values()];
}

function ignoredOpenAIParams(body) {
  const ignored = [];
  const unsupported = [
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "seed",
    "logprobs",
    "top_logprobs",
    "service_tier",
    "store",
    "metadata",
    "prediction",
    "audio",
    "prompt_cache_key",
    "prompt_cache_retention",
  ];
  for (const k of unsupported) {
    if (body[k] !== undefined && body[k] !== null) ignored.push(k);
  }
  return ignored;
}

module.exports = {
  BUILTIN_TOOLS,
  contentToText,
  buildMcpToolDefinitions,
  toolNameMap,
  normalizeToolName,
  CURSOR_BUILTIN_TOOL_NAMES,
  decodeMcpArgs,
  extraToolsPrompt,
  textToolsPrompt,
  parseClientToolLine,
  parseTextToolCalls,
  execToToolCall,
  toolResultToExecPayload,
  extractOpenAIToolResults,
  extractTrailingToolResults,
  lastAssistantToolCallIds,
  lastUserIndex,
  lastMessageIsTool,
  messagesToPrompt,
  publicToolCall,
  mergeToolLists,
  ignoredOpenAIParams,
  customToolNames,
  requestToolNames,
  BUILTIN_TOOL_NAMES,
};
