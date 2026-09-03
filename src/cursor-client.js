const fs = require("fs");
const http2 = require("http2");
const { v4: uuidv4 } = require("uuid");
const config = require("./config");
const {
  pickChatTransport,
  INFERENCE,
  CHAT_TOOLS,
  AGENT,
  INFERENCE_PATH,
  CHAT_SERVICE_PATH,
  AGENT_PATH,
  buildChatServiceRequest,
} = require("./chat-transport");
const { familyId } = require("./model-family");
const execHost = require("./exec-host");
const openaiMap = require("./openai-map");
const { encodeFrame, createFrameReader } = require("./connect-frame");
const { createBlobStore } = require("./history");
const { createWatchdogs } = require("./watchdog");
const { createEventQueue } = require("./event-queue");
const { createOutputLimiter } = require("./output-limit");
const { createAgentScratch } = require("./agent-scratch");
const {
  buildInferenceRequest,
  createToolCallAccumulator,
  ingestResponseInfo,
  normalizeOpenAIToolCalls,
} = require("./inference-protocol");
const { parseTextToolCalls } = require("./tool-parse");
const { inferenceErrorTypeName } = require("./openai-protocol");

function partText(part) {
  if (part == null) return "";
  if (typeof part === "string" || typeof part === "number") return String(part);
  if (typeof part !== "object") return "";
  const v = part.text ?? part.delta ?? part.thinking ?? part.textDelta ?? part.content ?? part.value;
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && (v.text || v.delta)) return String(v.text || v.delta);
  return "";
}

function generateChecksum(machineId, macMachineId) {
  let k = 165;
  const t = Math.floor(Date.now() / 1e6);
  const b = new Uint8Array([
    (t >> 40) & 255,
    (t >> 32) & 255,
    (t >> 24) & 255,
    (t >> 16) & 255,
    (t >> 8) & 255,
    t & 255,
  ]);
  for (let i = 0; i < b.length; i++) {
    b[i] = ((b[i] ^ k) + (i % 256)) & 0xff;
    k = b[i];
  }
  const prefix = Buffer.from(b).toString("base64");
  return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}

// Queries the server can only proceed past once the client says yes or no.
const APPROVABLE_QUERIES = {
  webSearchRequestQuery: "webSearchRequestResponse",
  exaSearchRequestQuery: "exaSearchRequestResponse",
  exaFetchRequestQuery: "exaFetchRequestResponse",
  switchModeRequestQuery: "switchModeRequestResponse",
};

// Proto int64 fields arrive as strings over connect+json.
function intField(raw, fallback = 0) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

// Over connect+json the useful part of an error is a `debug` object on the
// first detail; `message` on its own is the literal string "Error". Reading only
// the protobuf-style base64 `value` collapsed every upstream failure into one
// unclassifiable message.
function inferenceStreamErrorText(error) {
  if (!error || typeof error !== "object") return "";
  const type = inferenceErrorTypeName(error.errorType ?? error.error_type);
  const flags = [];
  if (error.isInputTokenLimitError || error.is_input_token_limit_error) flags.push("INPUT_TOKEN_LIMIT");
  if (error.isOutputTokenLimitError || error.is_output_token_limit_error) flags.push("OUTPUT_TOKEN_LIMIT");
  const bits = [type, error.code, flags.join(" ")].filter(Boolean);
  const message = error.message && error.message !== "Error" ? error.message : "";
  if (message) bits.push(message);
  if (
    bits.length &&
    (type || flags.length || error.errorType != null || error.error_type != null || error.isInputTokenLimitError || error.is_input_token_limit_error)
  ) {
    return bits.join(": ");
  }
  return "";
}

function errorDetail(error) {
  const inf = inferenceStreamErrorText(error);
  if (inf) return inf;
  const detail = error && Array.isArray(error.details) ? error.details[0] : null;
  if (detail) {
    if (detail.debug) {
      const debug = detail.debug;
      const named = debug.details && (debug.details.detail || debug.details.title);
      const parts = [debug.error, named].filter(Boolean);
      if (parts.length) return parts.join(": ");
      return JSON.stringify(debug).slice(0, 400);
    }
    if (detail.value) {
      try {
        const decoded = Buffer.from(detail.value, "base64").toString("utf8");
        if (decoded) return decoded;
      } catch {}
    }
  }
  return (error && (error.message || error.code)) || "Unknown error";
}

function trailerError(frame) {
  if (frame && frame.trailer && frame.trailer.error) return errorDetail(frame.trailer.error);
  return (frame && frame.error) || "";
}

function readableError(raw) {
  if (!raw) return "Unknown error";
  const s = String(raw);
  const named = s.match(/Model name is not valid: "[^"]+"/);
  if (named) return named[0];
  if (s.includes("Other Models usage limit reached")) {
    return "Other Models usage limit reached";
  }
  return s.replace(/[^\x20-\x7E\u4e00-\u9fff]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function buildHeaders(token, path, options = {}) {
  const requestId = uuidv4();
  const headers = {
    ":method": "POST",
    ":path": path,
    // Only the bidirectional Run stream is enveloped. Unary calls take a bare
    // JSON body, and mixing the two content types gets a bodyless 415.
    "content-type": /\/(Run|Stream)$/.test(path) ? "application/connect+json" : "application/json",
    "connect-protocol-version": "1",
    authorization: `Bearer ${token.accessToken}`,
    "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
    "x-cursor-client-version": config.cursor.clientVersion,
    "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "x-request-id": requestId,
    "x-original-request-id": requestId,
  };
  if (config.cursor.userAgent) headers["user-agent"] = config.cursor.userAgent;
  if (config.cursor.acceptGzip) headers["connect-accept-encoding"] = "gzip";
  if (config.cursor.ghostMode) headers["x-ghost-mode"] = config.cursor.ghostMode;
  if (config.cursor.clientType) {
    headers["x-cursor-client-type"] = config.cursor.clientType;
  }
  if (config.cursor.clientType === "sand" && config.cursor.sandNamespace) {
    headers["x-sand-box-namespace"] = config.cursor.sandNamespace;
  }
  if (
    config.cursor.allowedNativeTools.length &&
    !options.omitAllowedTools
  ) {
    headers["x-cursor-agent-allowed-tools"] = config.cursor.allowedNativeTools.join(",");
  }
  return headers;
}

function reply(writeFrame, id, execId, payload, startedAt) {
  writeFrame({
    execClientMessage: {
      id,
      execId,
      localExecutionTimeMs: Date.now() - startedAt,
      ...payload,
    },
  });
}

function headless(name, extra) {
  return extra || { error: { error: "tools disabled (TOOL_MODE=none)" } };
}

function rejectDeferred(writeFrame, id, execId, resultKey, reason, started) {
  const payload = {};
  if (resultKey === "shellResult") payload.shellResult = { rejected: { reason } };
  else if (resultKey === "readResult" || resultKey === "redactedReadResult") {
    payload[resultKey] = { error: { error: reason } };
  } else if (resultKey === "lsResult") payload.lsResult = { error: { path: "", error: reason } };
  else if (resultKey === "grepResult") payload.grepResult = { error: { error: reason } };
  else if (resultKey === "writeResult") payload.writeResult = { rejected: { reason } };
  else if (resultKey === "deleteResult") payload.deleteResult = { rejected: { reason } };
  else if (resultKey === "fetchResult") payload.fetchResult = { error: { url: "", error: reason } };
  else if (resultKey === "mcpResult") payload.mcpResult = { error: { error: reason } };
  else payload.requestContextResult = { error: { error: reason } };
  reply(writeFrame, id, execId, payload, started);
}

function toolAllowed(opts, name) {
  if (opts.toolChoice === "none") return false;
  if (!opts.allowedToolNames || !opts.allowedToolNames.size) return false;
  return opts.allowedToolNames.has(name);
}

async function handleExecMessage(exec, writeFrame, onTool, opts = {}) {
  const { id = 0, execId = "" } = exec;
  const started = Date.now();
  const mode = opts.mode || config.tools.mode;
  const clientMode = mode === "client";
  const tools = mode === "workspace";
  const emit = (name, args, resultKind) => {
    if (onTool) onTool({ name, args: args || {}, kind: resultKind, ms: Date.now() - started });
  };

  try {
    if (exec.requestContextArgs) {
      const ctx = execHost.requestContextPayload(opts.workspace, opts.mcpTools, opts.webSearch);
      reply(
        writeFrame,
        id,
        execId,
        { requestContextResult: { success: { requestContext: ctx } } },
        started
      );
      emit("requestContext", {}, "ok");
      return "requestContext";
    }

    if (exec.shellAllowlistPrecheckArgs) {
      reply(
        writeFrame,
        id,
        execId,
        {
          shellAllowlistPrecheckResult: {
            allowlisted: clientMode ? toolAllowed(opts, "shell") : execHost.shellEnabled(),
          },
        },
        started
      );
      emit("shellAllowlistPrecheck", exec.shellAllowlistPrecheckArgs, "ok");
      return "shellAllowlistPrecheck";
    }
    if (exec.mcpAllowlistPrecheckArgs) {
      reply(
        writeFrame,
        id,
        execId,
        { mcpAllowlistPrecheckResult: { allowlisted: Boolean(clientMode && opts.hasCustomTools) } },
        started
      );
      emit("mcpAllowlistPrecheck", exec.mcpAllowlistPrecheckArgs, "deny");
      return "mcpAllowlistPrecheck";
    }
    if (exec.webFetchAllowlistPrecheckArgs) {
      reply(
        writeFrame,
        id,
        execId,
        {
          webFetchAllowlistPrecheckResult: {
            allowlisted: clientMode ? toolAllowed(opts, "web_fetch") : execHost.fetchEnabled(),
          },
        },
        started
      );
      emit("webFetchAllowlistPrecheck", exec.webFetchAllowlistPrecheckArgs, "ok");
      return "webFetchAllowlistPrecheck";
    }

    // The agent's own bookkeeping, not a tool call the caller can execute:
    // web search results land here and are read straight back.
    const scratch = opts.scratch;
    if (scratch) {
      const write = exec.writeArgs || exec.piWriteArgs;
      if (write && scratch.owns(write.path)) {
        reply(writeFrame, id, execId, { writeResult: scratch.write(write) }, started);
        emit("scratchWrite", { path: write.path }, "ok");
        return "scratchWrite";
      }
      const read = exec.readArgs || exec.redactedReadArgs || exec.piReadArgs;
      if (read && scratch.owns(read.path)) {
        const key = exec.redactedReadArgs ? "redactedReadResult" : "readResult";
        reply(writeFrame, id, execId, { [key]: scratch.read(read) }, started);
        emit("scratchRead", { path: read.path }, "ok");
        return "scratchRead";
      }
      const ls = exec.lsArgs || exec.piLsArgs;
      if (ls && scratch.owns(ls.path)) {
        reply(writeFrame, id, execId, { lsResult: scratch.list(ls) }, started);
        return "scratchLs";
      }
      if (exec.deleteArgs && scratch.owns(exec.deleteArgs.path)) {
        reply(writeFrame, id, execId, { deleteResult: scratch.remove(exec.deleteArgs) }, started);
        return "scratchDelete";
      }
    }

    if (clientMode && opts.toolChoice !== "none") {
      const call = openaiMap.execToToolCall(exec, opts.toolNames);
      if (call) {
        call._id = id;
        call._execId = execId;
        if (!toolAllowed(opts, call.function.name)) {
          emit(call.function.name, {}, "reject-not-registered");
          rejectDeferred(
            writeFrame,
            id,
            execId,
            call._resultKey,
            `built-in ${call.function.name} is blocked; only client-registered OpenAI tools are allowed`,
            started
          );
          return "rejected";
        }
        emit(call.function.name, JSON.parse(call.function.arguments || "{}"), "defer");
        return { defer: true, call };
      }
    }

    if (exec.readArgs || exec.redactedReadArgs || exec.piReadArgs) {
      const args = exec.readArgs || exec.redactedReadArgs || exec.piReadArgs;
      const key = exec.redactedReadArgs ? "redactedReadResult" : "readResult";
      const result = tools ? await execHost.doRead(args) : { fileNotFound: { path: args.path || "" } };
      reply(writeFrame, id, execId, { [key]: result }, started);
      emit("read", args, result.success ? "ok" : "err");
      return "read";
    }

    if (exec.lsArgs || exec.piLsArgs) {
      const args = exec.lsArgs || exec.piLsArgs;
      const result = tools
        ? await execHost.doLs(args)
        : { error: { path: args.path || "", error: "tools disabled" } };
      reply(writeFrame, id, execId, { lsResult: result }, started);
      emit("ls", args, result.success ? "ok" : "err");
      return "ls";
    }

    if (exec.grepArgs || exec.piGrepArgs || exec.piFindArgs) {
      const args = exec.grepArgs || exec.piGrepArgs || exec.piFindArgs;
      const result = tools ? await execHost.doGrep(args) : { error: { error: "tools disabled" } };
      reply(writeFrame, id, execId, { grepResult: result }, started);
      emit("grep", args, result.success ? "ok" : "err");
      return "grep";
    }

    if (exec.writeArgs || exec.piWriteArgs) {
      const args = exec.writeArgs || exec.piWriteArgs;
      const result = tools
        ? await execHost.doWrite(args)
        : { rejected: { reason: "tools disabled" } };
      reply(writeFrame, id, execId, { writeResult: result }, started);
      emit("write", { path: args.path }, result.success ? "ok" : "err");
      return "write";
    }

    if (exec.deleteArgs) {
      const result = tools
        ? await execHost.doDelete(exec.deleteArgs)
        : { rejected: { reason: "tools disabled" } };
      reply(writeFrame, id, execId, { deleteResult: result }, started);
      emit("delete", exec.deleteArgs, result.success ? "ok" : "err");
      return "delete";
    }

    if (exec.shellArgs || exec.shellStreamArgs || exec.piBashArgs || exec.miniSweAgentBashArgs) {
      const args = exec.shellArgs || exec.shellStreamArgs || exec.piBashArgs || exec.miniSweAgentBashArgs;
      const result = execHost.shellEnabled()
        ? await execHost.runShell(args)
        : { rejected: { reason: "ENABLE_SHELL is off" } };
      reply(writeFrame, id, execId, { shellResult: result }, started);
      emit("shell", { command: args.command }, result.success ? "ok" : "err");
      return "shell";
    }

    if (exec.fetchArgs) {
      const result = execHost.fetchEnabled()
        ? await execHost.doFetch(exec.fetchArgs)
        : { error: { url: exec.fetchArgs.url || "", error: "fetch disabled" } };
      reply(writeFrame, id, execId, { fetchResult: result }, started);
      emit("fetch", exec.fetchArgs, result.success ? "ok" : "err");
      return "fetch";
    }

    if (exec.gitDiffRequest) {
      const result = await execHost.doGitDiff();
      reply(writeFrame, id, execId, { gitDiffResponse: result }, started);
      emit("gitDiff", {}, result.success ? "ok" : "err");
      return "gitDiff";
    }

    if (exec.diagnosticsArgs || exec.canvasDiagnosticsArgs) {
      reply(writeFrame, id, execId, { diagnosticsResult: { diagnostics: [] } }, started);
      emit("diagnostics", {}, "ok");
      return "diagnostics";
    }

    if (exec.mcpArgs) {
      reply(writeFrame, id, execId, { mcpResult: { error: { error: "MCP not configured" } } }, started);
      emit("mcp", {}, "deny");
      return "mcp";
    }
    if (exec.listMcpResourcesExecArgs) {
      reply(
        writeFrame,
        id,
        execId,
        { listMcpResourcesExecResult: { error: { error: "MCP not configured" } } },
        started
      );
      return "mcpList";
    }
    if (exec.readMcpResourceExecArgs) {
      reply(
        writeFrame,
        id,
        execId,
        { readMcpResourceExecResult: { error: { error: "MCP not configured" } } },
        started
      );
      return "mcpRead";
    }

    if (exec.subagentArgs || exec.subagentAwaitArgs || exec.forceBackgroundSubagentArgs) {
      reply(
        writeFrame,
        id,
        execId,
        { subagentResult: { error: { error: "subagents not supported in proxy" } } },
        started
      );
      emit("subagent", {}, "deny");
      return "subagent";
    }

    if (exec.backgroundShellSpawnArgs || exec.forceBackgroundShellArgs) {
      reply(
        writeFrame,
        id,
        execId,
        { backgroundShellSpawnResult: { error: { error: "background shell not supported" } } },
        started
      );
      emit("backgroundShell", {}, "deny");
      return "backgroundShell";
    }

    if (exec.computerUseArgs || exec.recordScreenArgs) {
      reply(
        writeFrame,
        id,
        execId,
        { computerUseResult: { error: { error: "computer use not supported" } } },
        started
      );
      emit("computerUse", {}, "deny");
      return "computerUse";
    }

    if (exec.smartModeClassifierArgs) {
      reply(
        writeFrame,
        id,
        execId,
        { smartModeClassifierResult: { allow: true } },
        started
      );
      return "smartMode";
    }

    if (exec.executeHookArgs) {
      reply(writeFrame, id, execId, { executeHookResult: {} }, started);
      return "hook";
    }

    reply(
      writeFrame,
      id,
      execId,
      { requestContextResult: { error: { error: `unhandled exec: ${Object.keys(exec).join(",")}` } } },
      started
    );
    emit("unknown", { keys: Object.keys(exec) }, "deny");
    return "unknown";
  } catch (e) {
    reply(
      writeFrame,
      id,
      execId,
      { requestContextResult: { error: { error: e.message } } },
      started
    );
    emit("exception", { error: e.message }, "err");
    return "exception";
  }
}

function createInferenceRun(token, prompt, modelId, options = {}) {
  const conversationId = options.conversationId || uuidv4();
  const onDelta = options.onDelta || null;
  const onThinking = options.onThinking || null;
  const signal = options.signal || null;
  const events = createEventQueue();
  const limiter = createOutputLimiter({ maxTokens: options.maxTokens, stops: options.stops });
  const readFrames = createFrameReader();
  let done = false;
  let finishing = false;
  let errorMsg = "";
  let fullText = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let thinkingMs = 0;
  let client;
  let req;
  let socketDead = false;
  const toolTrace = [];
  const toolAcc = createToolCallAccumulator();
  const reasoningParts = [];
  let currentThinking = { text: "", signature: "" };

  const emitEvent = (ev) => events.emit(ev);
  const wait = () => events.next();

  function usageSnapshot() {
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      cutReason: limiter.reason(),
      stopSequence: limiter.stopSequence(),
    };
  }

  function ingestText(t) {
    if (!t || limiter.tripped()) return;
    const allowed = limiter.push(t);
    if (allowed) {
      fullText += allowed;
      // Text-tool families (Claude on sand) write invoke_client_tool in the
      // body. Streaming that marker as content then flipping to tool_calls
      // confuses OpenAI clients; hold deltas until finish classifies the turn.
      if (onDelta && !options.textToolsOnly && !options.xmlToolFormat) onDelta(allowed);
    }
    if (limiter.tripped()) finish("done");
  }

  function flushThinkingPart() {
    if (!currentThinking.text && !currentThinking.signature) return;
    reasoningParts.push({
      text: currentThinking.text,
      signature: currentThinking.signature,
      isRedacted: false,
    });
    currentThinking = { text: "", signature: "" };
  }

  function ingestThinking(t, extra = {}) {
    if (t) {
      thinkingText += t;
      currentThinking.text += t;
      if (onThinking) onThinking(t);
    }
    if (extra.signature) currentThinking.signature = extra.signature;
    if (extra.isFinal) flushThinkingPart();
  }

  function closeSocket() {
    try { if (req) req.close(); } catch {}
    try { if (client) client.close(); } catch {}
  }

  function finish(kind) {
    if (done || finishing) return;
    finishing = true;
    closeSocket();
    done = true;
    flushThinkingPart();
    emitEvent({
      type: errorMsg ? "error" : kind || "done",
      text: fullText,
      thinking: thinkingText,
      reasoningParts: reasoningParts.slice(),
      ...usageSnapshot(),
      thinkingMs,
      conversationId,
      toolTrace,
      error: errorMsg ? readableError(errorMsg) : null,
    });
  }

  try {
    client = http2.connect(config.cursor.baseUrl);
  } catch (e) {
    setTimeout(() => emitEvent({ type: "error", error: `Connection failed: ${e.message}`, conversationId }), 0);
    return {
      conversationId,
      wait,
      alive: () => false,
      submit() { return 0; },
      abort() {},
    };
  }
  client.on("error", () => {});
  const rpcPath = options.rpcPath || INFERENCE_PATH;
  const transport = options.transport || INFERENCE;
  // Keep x-cursor-agent-allowed-tools even on Claude XML turns. Omitting it
  // lets Cursor inject the full native registry; Claude then 429s
  // resource_exhausted. The header is what makes a tools turn look like the
  // working no-tool path.
  req = client.request(buildHeaders(token, rpcPath));
  req.setTimeout(0);
  if (signal) {
    signal.addEventListener("abort", () => {
      errorMsg = "Request aborted";
      finish("error");
    }, { once: true });
  }

  req.on("response", (h) => {
    const status = Number(h[":status"] || 0);
    if (status && status !== 200) {
      errorMsg = `upstream HTTP ${status}`;
      finish("error");
    }
  });

  req.on("data", (chunk) => {
    for (const frame of readFrames(chunk)) {
      if (frame.kind === "invalid") continue;
      if (frame.kind === "trailer") {
        if (frame.error || (frame.trailer && frame.trailer.error)) {
          errorMsg = trailerError(frame);
          finish("error");
        }
        return;
      }
      const msg = frame.message || {};
      if (msg.error) {
        errorMsg = errorDetail(msg.error);
        finish("error");
        return;
      }
      const part = msg.textPart || msg.text_part;
      const visible = partText(part);
      if (visible) ingestText(visible);
      const think = msg.thinkingPart || msg.thinking_part;
      if (think) {
        ingestThinking(partText(think), {
          signature: think.signature || "",
          isFinal: Boolean(think.isFinal || think.is_final),
        });
      }
      if (typeof msg.text === "string") ingestText(msg.text);
      const unified = msg.streamUnifiedChatResponse || msg.streamUnifiedChatResponseWithTools;
      if (unified && typeof unified.text === "string") ingestText(unified.text);
      if (unified && unified.thinking) ingestThinking(partText(unified.thinking));
      const usage = msg.usage || msg.extendedUsage || msg.extended_usage;
      if (usage) {
        inputTokens = intField(usage.promptTokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens, inputTokens);
        outputTokens = intField(usage.completionTokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens, outputTokens);
        cacheReadTokens = intField(usage.cacheReadTokens ?? usage.cache_read_tokens, cacheReadTokens);
        cacheWriteTokens = intField(usage.cacheWriteTokens ?? usage.cache_write_tokens, cacheWriteTokens);
      }
      const tool = msg.toolCallPart || msg.tool_call_part;
      if (tool) toolAcc.ingest(tool);
      ingestResponseInfo(msg.responseInfo || msg.response_info, toolAcc);
    }
  });

  req.on("end", () => {
    socketDead = true;
    if (done || finishing) return;
    const mapName = (n) =>
      options.toolNames && typeof options.toolNames.caller === "function"
        ? options.toolNames.caller(n)
        : n;
    let calls = toolAcc.toOpenAICalls(mapName, uuidv4);
    // Text/XML salvage is Claude-only. Kimi and the rest already speak
    // Inference tool_call_part; parsing prose would hide a native-args bug
    // and teach the model the wrong format.
    if (
      !calls.length &&
      (options.textToolsOnly || options.xmlToolFormat) &&
      options.toolChoice !== "none" &&
      Array.isArray(options.openaiTools) &&
      options.openaiTools.length
    ) {
      const allowed = new Set();
      for (const t of options.openaiTools) {
        const fn = t && (t.function || t);
        if (!fn || !fn.name) continue;
        allowed.add(fn.name);
        if (options.toolNames && typeof options.toolNames.wire === "function") {
          allowed.add(options.toolNames.wire(fn.name));
        }
        if (options.toolNames && typeof options.toolNames.caller === "function") {
          allowed.add(options.toolNames.caller(fn.name));
        }
      }
      const parsed = parseTextToolCalls(fullText, {
        allowed,
        toolChoice: options.toolChoice,
        mapName,
        protocolTurn: Boolean(options.textToolsOnly || options.xmlToolFormat),
      });
      if (parsed.calls.length) {
        calls = parsed.calls;
        fullText = parsed.cleaned;
      }
    }
    if (calls.length) {
      calls = normalizeOpenAIToolCalls(calls, {
        userText: options.inferenceUserText || prompt,
        thinking: thinkingText,
        messages: options.sourceMessages,
      });
      finishing = true;
      done = true;
      closeSocket();
      flushThinkingPart();
      emitEvent({
        type: "tool_calls",
        tool_calls: calls,
        conversationId,
        text: fullText,
        thinking: thinkingText,
        reasoningParts: reasoningParts.slice(),
        ...usageSnapshot(),
        thinkingMs,
        toolTrace,
      });
      return;
    }
    finish(errorMsg ? "error" : "done");
  });
  req.on("error", (e) => {
    errorMsg = e.message;
    finish("error");
  });
  req.on("timeout", () => {
    errorMsg = "Request timeout";
    finish("error");
  });

  const body =
    typeof options.buildBody === "function"
      ? options.buildBody({
          prompt,
          modelId,
          conversationId,
          userText: options.inferenceUserText,
          systemText: options.inferenceSystem,
          rootMessages: options.rootMessages,
          openaiTools: options.openaiTools,
          toolNames: options.toolNames,
          toolChoice: options.toolChoice,
          maxTokens: options.maxTokens,
          stops: options.stops,
          temperature: options.temperature,
          topP: options.topP,
          textToolsOnly: options.textToolsOnly,
          xmlToolFormat: options.xmlToolFormat,
          images: options.images,
          documents: options.documents,
        })
      : buildInferenceRequest({
          prompt,
          modelId,
          conversationId,
          rootMessages: options.rootMessages,
          userText: options.inferenceUserText,
          systemText: options.inferenceSystem,
          openaiTools: options.openaiTools,
          toolNames: options.toolNames,
          toolChoice: options.toolChoice,
          maxTokens: options.maxTokens,
          stops: options.stops,
          temperature: options.temperature,
          topP: options.topP,
          textToolsOnly: options.textToolsOnly,
          xmlToolFormat: options.xmlToolFormat,
          images: options.images,
          documents: options.documents,
        });
  req.write(encodeFrame(body));
  req.end();

  return {
    conversationId,
    transport,
    rpcPath,
    wait,
    alive: () => !done && !finishing && !socketDead,
    submit() { return 0; },
    abort() {
      errorMsg = "Request aborted";
      finish("error");
    },
  };
}

function createChatServiceRun(token, prompt, modelId, options = {}) {
  return createInferenceRun(token, prompt, modelId, {
    ...options,
    rpcPath: CHAT_SERVICE_PATH,
    buildBody: buildChatServiceRequest,
    transport: CHAT_TOOLS,
  });
}

let chatMatrix = null;
function loadChatMatrix() {
  if (chatMatrix) return chatMatrix;
  const p = process.env.CHAT_RPC_MATRIX || "";
  if (!p || !fs.existsSync(p)) {
    chatMatrix = [];
    return chatMatrix;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    chatMatrix = Array.isArray(raw) ? raw : raw.rows || [];
  } catch {
    chatMatrix = [];
  }
  return chatMatrix;
}

function resolveSandRun(modelId, options = {}) {
  const kind =
    options.chatTransport ||
    pickChatTransport(modelId, options.matrix || loadChatMatrix(), { familyId });
  if (kind === CHAT_TOOLS) return createChatServiceRun;
  if (kind === AGENT) return createAgentRun;
  return createInferenceRun;
}

function createRun(token, prompt, modelId, options = {}) {
  if ((config.cursor.clientType || "sand") === "sand") {
    return resolveSandRun(modelId, options)(token, prompt, modelId, options);
  }
  return createAgentRun(token, prompt, modelId, options);
}

function createAgentRun(token, prompt, modelId, options = {}) {
  const conversationId = options.conversationId || uuidv4();
  const mode = options.mode || config.tools.mode;
  const onDelta = options.onDelta || null;
  const onThinking = options.onThinking || null;
  const onTool = options.onTool || null;
  const signal = options.signal || null;
  const allowedToolNames = options.allowedToolNames instanceof Set
    ? options.allowedToolNames
    : options.allowedToolNames
      ? new Set(options.allowedToolNames)
      : null;
  const mcpTools = Array.isArray(options.mcpTools) ? options.mcpTools : [];
  const rootMessages = Array.isArray(options.rootMessages) ? options.rootMessages : [];
  const blobs = createBlobStore();
  const execOpts = {
    mode,
    workspace: options.workspace,
    toolChoice: options.toolChoice,
    hasCustomTools: Boolean(options.hasCustomTools),
    allowedToolNames,
    mcpTools,
    toolNames: options.toolNames,
    webSearch: Boolean(options.webSearch),
    scratch: options.webSearch ? createAgentScratch() : null,
  };

  const events = createEventQueue();
  const limiter = createOutputLimiter({ maxTokens: options.maxTokens, stops: options.stops });
  const inflight = new Map();
  const pendingCalls = [];
  let flushTimer = null;
  let fullText = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let thinkingMs = 0;
  const readFrames = createFrameReader();
  let done = false;
  let finishing = false;
  let errorMsg = "";
  let execQueue = Promise.resolve();
  const toolTrace = [];
  let client;
  let req;
  let lineHold = "";
  let hidingTools = false;
  let socketDead = false;
  let awaitingFollowup = false;
  let turnCompleted = false;
  const seenIu = new Set();

  function asText(v) {
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(asText).join("");
    return v.text || v.delta || v.token || v.content || v.value || "";
  }

  function ingestText(t) {
    if (!t || limiter.tripped()) return;
    const allowed = limiter.push(t);
    if (allowed) {
      fullText += allowed;
      emitVisibleText(allowed);
    }
    // The caller capped the answer; letting the upstream keep generating only
    // spends quota on text nobody will ever see.
    if (limiter.tripped()) finish("done");
  }

  function flushLimiter() {
    const tail = limiter.flush();
    if (tail) {
      fullText += tail;
      emitVisibleText(tail);
    }
  }

  function ingestThinking(t) {
    if (!t) return;
    thinkingText += t;
    if (onThinking) onThinking(t);
  }

  function couldBeToolMarker(s) {
    const t = String(s || "").trimStart().toLowerCase();
    if (!t) return false;
    return "invoke_client_tool".startsWith(t) || t.startsWith("invoke_client_tool") || "client_tool".startsWith(t) || t.startsWith("client_tool");
  }

  function emitVisibleText(chunk) {
    if (!chunk || hidingTools) return;
    lineHold += chunk;
    while (!hidingTools) {
      const nl = lineHold.indexOf("\n");
      if (nl < 0) break;
      const line = lineHold.slice(0, nl);
      lineHold = lineHold.slice(nl + 1);
      if (/^\s*(invoke_client_tool|CLIENT_TOOL)\b/i.test(line)) {
        hidingTools = true;
        lineHold = "";
        return;
      }
      if (onDelta) onDelta(line + "\n");
    }
    if (!hidingTools && lineHold && !couldBeToolMarker(lineHold) && onDelta) {
      onDelta(lineHold);
      lineHold = "";
    }
  }

  function flushVisibleHold() {
    if (hidingTools) {
      lineHold = "";
      return;
    }
    if (lineHold && !/^\s*(invoke_client_tool|CLIENT_TOOL)\b/i.test(lineHold) && onDelta) {
      onDelta(lineHold);
    }
    lineHold = "";
  }

  const emitEvent = (ev) => events.emit(ev);
  const wait = () => events.next();

  function usageSnapshot() {
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      cutReason: limiter.reason(),
      stopSequence: limiter.stopSequence(),
    };
  }

  function flushPending() {
    if (!pendingCalls.length) return;
    const calls = normalizeOpenAIToolCalls(pendingCalls.splice(0), {
      userText: options.inferenceUserText || prompt,
      thinking: thinkingText,
      messages: options.sourceMessages,
    });
    emitEvent({
      type: "tool_calls",
      tool_calls: calls,
      conversationId,
      text: fullText,
      thinking: thinkingText,
      ...usageSnapshot(),
      thinkingMs,
      toolTrace,
    });
  }

  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushPending, 100);
  }

  const writeFrameFn = (obj) => {
    try {
      req.write(encodeFrame(obj));
    } catch {}
  };

  const heartbeat = setInterval(() => {
    writeFrameFn({ clientHeartbeat: {} });
  }, config.cursor.heartbeatInterval);

  const watchdogs = createWatchdogs({
    idleMs: config.cursor.idleTimeout,
    outputMs: config.cursor.outputTimeout,
    isParked: () => inflight.size > 0,
    onTrip: (reason) => {
      errorMsg = reason;
      finish("error");
    },
  });

  function cleanup() {
    if (done) return;
    done = true;
    clearInterval(heartbeat);
    watchdogs.stop();
    clearTimeout(flushTimer);
    try {
      req.end();
    } catch {}
    setTimeout(() => {
      try {
        req.close();
      } catch {}
      try {
        client.close();
      } catch {}
    }, 200);
  }

  function finish(kind) {
    if (finishing) return;
    finishing = true;
    const wrap = async () => {
      try {
        await execQueue;
      } catch {}
      flushLimiter();
      clearTimeout(flushTimer);
      if (pendingCalls.length) flushPending();
      cleanup();
      emitEvent({
        type: errorMsg ? "error" : kind || "done",
        text: fullText,
        thinking: thinkingText,
        ...usageSnapshot(),
        thinkingMs,
        conversationId,
        toolTrace,
        error: errorMsg ? readableError(errorMsg) : null,
      });
    };
    wrap();
  }

  try {
    client = http2.connect(config.cursor.baseUrl);
  } catch (e) {
    setTimeout(() => emitEvent({ type: "error", error: `Connection failed: ${e.message}`, conversationId }), 0);
    return {
      conversationId,
      wait,
      alive: () => false,
      submit() {
        return 0;
      },
      abort() {},
    };
  }
  client.on("error", () => {});
  req = client.request(buildHeaders(token, "/agent.v1.AgentService/Run"));
  // Multi-round OpenAI tool_calls keep this HTTP/2 stream open while the
  // caller executes tools. Node's request timeout is idle-on-read and would
  // kill a legitimate wait, so armIdle() below owns the deadline instead.
  req.setTimeout(0);

  req.on("response", (h) => {
    const status = Number(h[":status"] || 0);
    if (status && status !== 200) {
      errorMsg = `upstream HTTP ${status}`;
      finish("error");
    }
  });

  if (signal) {
    signal.addEventListener(
      "abort",
      () => {
        errorMsg = "Request aborted";
        finish("error");
      },
      { once: true }
    );
  }

  // Returns true when the run is over and the rest of the batch can be dropped.
  function handleMessage(msg) {
    // Heartbeats prove the socket is alive but not that the turn is moving, so
    // Every frame proves the socket is alive. Only text and thinking prove the
    // turn is producing an answer — the first probe against this API hung for
    // minutes on heartbeats while the server waited for a reply that never came.
    watchdogs.frame();

    if (msg.error) {
      errorMsg = errorDetail(msg.error);
      finish("error");
      return true;
    }
    if (msg.execServerMessage) {
      execQueue = execQueue.then(async () => {
        const ret = await handleExecMessage(msg.execServerMessage, writeFrameFn, (ev) => {
          toolTrace.push(ev);
          if (onTool) onTool(ev);
        }, execOpts);
        if (ret && ret.defer && ret.call) {
          inflight.set(ret.call.id, ret.call);
          pendingCalls.push(ret.call);
          scheduleFlush();
        }
      });
      return false;
    }
    if (msg.kvServerMessage) {
      // History lives client-side; the server pulls each entry back by the
      // sha256 it was announced under. Leaving a get unanswered wedges the turn.
      const kv = msg.kvServerMessage;
      if (kv.getBlobArgs) {
        const data = blobs.get(kv.getBlobArgs.blobId);
        writeFrameFn({
          kvClientMessage: { id: kv.id, getBlobResult: data ? { blobData: data } : {} },
        });
      } else if (kv.setBlobArgs) {
        blobs.set(kv.setBlobArgs.blobId, kv.setBlobArgs.blobData);
        writeFrameFn({ kvClientMessage: { id: kv.id, setBlobResult: {} } });
      }
      return false;
    }
    if (msg.interactionUpdate) {
      const iu = msg.interactionUpdate;
      const iuKeys = Object.keys(iu).sort().join(",");
      if (iuKeys && !seenIu.has(iuKeys)) {
        seenIu.add(iuKeys);
        console.log(`iu ${iuKeys}`);
      }
      if (iu.heartbeat !== undefined) return false;
      if (iu.textDelta) {
        watchdogs.output();
        ingestText(asText(iu.textDelta));
        return false;
      }
      // TokenDeltaUpdate is a usage counter, not model output.
      if (iu.tokenDelta) {
        const n = Number(iu.tokenDelta.tokens);
        if (Number.isFinite(n) && n > outputTokens) outputTokens = n;
        return false;
      }
      if (iu.thinkingDelta) {
        watchdogs.output();
        ingestThinking(asText(iu.thinkingDelta));
        return false;
      }
      if (iu.thinkingCompleted) {
        thinkingMs = iu.thinkingCompleted.thinkingDurationMs || 0;
        return false;
      }
      if (iu.turnEnded || (iu.message && iu.message.turnEnded)) {
        const ended = iu.turnEnded || iu.message.turnEnded;
        inputTokens = intField(ended.inputTokens, inputTokens);
        outputTokens = intField(ended.outputTokens, outputTokens);
        cacheReadTokens = intField(ended.cacheReadInputTokens ?? ended.cacheRead, cacheReadTokens);
        cacheWriteTokens = intField(
          ended.cacheCreationInputTokens ?? ended.cacheWrite,
          cacheWriteTokens
        );
        reasoningTokens = intField(ended.reasoningTokens, reasoningTokens);
        turnCompleted = true;
        awaitingFollowup = false;
        flushLimiter();
        flushVisibleHold();
        const parsed = openaiMap.parseClientToolLine(fullText);
        const allowedCalls = parsed.calls.filter((c) => toolAllowed(execOpts, c.function.name));
        if (allowedCalls.length) {
          fullText = parsed.cleaned;
          for (const c of allowedCalls) {
            inflight.set(c.id, c);
            pendingCalls.push(c);
          }
          flushPending();
          return true;
        }
        fullText = parsed.cleaned || fullText;
        finish("done");
        return true;
      }
      if (iu.stepCompleted || iu.stepStarted) return false;
      // Cursor drives its own tools server-side; these only narrate what it is
      // doing, so they must not leak into the assistant body.
      if (iu.toolCallStarted || iu.toolCallCompleted || iu.partialToolCall || iu.toolCallDelta) {
        return false;
      }
      if (iu.summary || iu.summaryStarted || iu.summaryCompleted || iu.shellOutputDelta) {
        return false;
      }
      if (iu.text) ingestText(asText(iu.text));
      const m = iu.message;
      if (m) {
        if (m.textDelta) ingestText(asText(m.textDelta));
        if (m.text) ingestText(asText(m.text));
      }
      return false;
    }
    if (msg.conversationCheckpointUpdate) return false;
    if (msg.interactionQuery) {
      answerInteractionQuery(msg.interactionQuery);
      return false;
    }
    return false;
  }

  // The server asks permission before it runs its own web search, and waits.
  // Leaving the question unanswered wedges the turn until a watchdog fires —
  // observed 2026-08-30 with webSearchEnabled on and no reply.
  function answerInteractionQuery(query) {
    const kinds = Object.keys(query).filter((k) => k !== "id");
    const response = { id: query.id };
    let answered = null;

    for (const kind of kinds) {
      const field = APPROVABLE_QUERIES[kind];
      if (!field) continue;
      response[field] = options.webSearch ? { approved: {} } : { rejected: { reason: "web access is disabled on this gateway" } };
      answered = kind;
      break;
    }
    if (!answered) {
      // Nothing sensible to answer with, but a bare acknowledgement still beats
      // a stream that never moves again.
      console.log(`interactionQuery ${kinds.join(",") || "unknown"} acknowledged without a result`);
    }
    writeFrameFn({ interactionResponse: response });
  }

  req.on("data", (chunk) => {
    for (const frame of readFrames(chunk)) {
      if (frame.kind === "invalid") {
        console.log(`frame dropped: ${frame.error}`);
        continue;
      }
      if (frame.kind === "trailer") {
        // Connect puts stream errors in the end-of-stream envelope, behind an
        // HTTP 200. Treating it as a clean finish loses the real reason.
        if (frame.error || (frame.trailer && frame.trailer.error)) {
          errorMsg = trailerError(frame);
          finish("error");
        }
        return;
      }
      if (handleMessage(frame.message)) return;
    }
  });

  req.on("end", () => {
    socketDead = true;
    // Tool calls are already out with the caller; submit() will refuse on a dead
    // socket and server.js replays the history on a fresh Run.
    if (inflight.size > 0 && !awaitingFollowup) return;
    // A turn that never reached turnEnded was cut short. Reporting it as a
    // clean stop hands the caller a truncated answer that looks complete.
    if (!turnCompleted && !errorMsg) {
      errorMsg = "upstream closed the stream before the turn ended";
    }
    finish(errorMsg ? "error" : "done");
  });
  req.on("error", (e) => {
    errorMsg = e.message;
    finish("error");
  });
  req.on("timeout", () => {
    errorMsg = "Request timeout";
    finish("error");
  });

  const conversationState = {};
  if (rootMessages.length) {
    conversationState.rootPromptMessagesJson = rootMessages.map((entry) => blobs.put(entry));
  }
  const userMessage = { text: prompt, messageId: uuidv4() };
  const images = Array.isArray(options.images) ? options.images : [];
  const documents = Array.isArray(options.documents) ? options.documents : [];
  if (images.length || documents.length) {
    userMessage.selectedContext = {};
    if (images.length) userMessage.selectedContext.selectedImages = images;
    if (documents.length) userMessage.selectedContext.selectedDocuments = documents;
  }
  const runRequest = {
    conversationState,
    action: { userMessageAction: { userMessage } },
    clientSupportsInlineImages: true,
    modelDetails: {
      modelId,
      displayName: modelId,
      displayNameShort: modelId,
    },
    requestedModel: { modelId },
    conversationId,
  };
  if (mcpTools.length) runRequest.mcpTools = { mcpTools };
  writeFrameFn({ runRequest });
  watchdogs.start();

  return {
    conversationId,
    transport: AGENT,
    rpcPath: AGENT_PATH,
    wait,
    alive: () => !done && !finishing && !socketDead,
    submit(results) {
      if (done || finishing || socketDead) return 0;
      let n = 0;
      for (const res of results || []) {
        const call = inflight.get(res.tool_call_id);
        if (!call) continue;
        // Custom OpenAI functions are not Cursor exec messages. Replaying
        // them on this HTTP/2 stream after turnEnded yields an empty turn.
        // Return 0 so the converter starts a new Run with full history.
        if (call._kind === "client_text") continue;
        n += 1;
        const payload = openaiMap.toolResultToExecPayload(call, res.content);
        writeFrameFn({
          execClientMessage: {
            id: call._id,
            execId: call._execId,
            [call._resultKey]: payload,
          },
        });
        inflight.delete(res.tool_call_id);
      }
      if (n > 0) {
        fullText = "";
        thinkingText = "";
        hidingTools = false;
        lineHold = "";
        awaitingFollowup = true;
        turnCompleted = false;
        watchdogs.start();
      }
      return n;
    },
    abort() {
      errorMsg = "Request aborted";
      finish("error");
    },
  };
}

function unary(token, path, body) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(config.cursor.baseUrl);
    client.on("error", () => {});
    const req = client.request(buildHeaders(token, path));
    req.setTimeout(20000);
    let text = "";
    req.on("data", (c) => (text += c.toString()));
    req.on("end", () => {
      client.close();
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error(`${path}: response was not JSON`));
      }
    });
    req.on("error", (e) => {
      client.close();
      reject(e);
    });
    req.on("timeout", () => {
      req.close();
      client.close();
      reject(new Error(`${path}: timeout`));
    });
    req.write(JSON.stringify(body || {}));
    req.end();
  });
}

async function getModels(token) {
  try {
    return await unary(token, "/agent.v1.AgentService/GetUsableModels", {});
  } catch {
    return { models: [] };
  }
}

// The catalog that carries per-model parameter definitions. A different service
// from GetUsableModels, and it only returns the definitions when asked.
function getModelCatalog(token, body) {
  return unary(token, "/aiserver.v1.AiService/AvailableModels", body);
}

function getSandUsage(token) {
  return unary(token, "/aiserver.v1.DashboardService/GetSandUsageStatus", {});
}

function getHardLimit(token) {
  return unary(token, "/aiserver.v1.DashboardService/GetHardLimit", {});
}

function getTimeLeft(token) {
  return unary(token, "/aiserver.v1.AiService/TimeLeftHealthCheck", {});
}

function settledOrError(result) {
  if (result.status === "fulfilled") return result.value;
  const err = result.reason;
  return { error: err && err.message ? err.message : "failed" };
}

// Usage / quota unaries that accept sand. Identity (GetMe / GetEmail) stays
// off the public /health surface.
async function getSandStatus(token) {
  const [usage, hardLimit, timeLeft] = await Promise.allSettled([
    getSandUsage(token),
    getHardLimit(token),
    getTimeLeft(token),
  ]);
  return {
    usage: settledOrError(usage),
    hardLimit: settledOrError(hardLimit),
    timeLeft: settledOrError(timeLeft),
  };
}

module.exports = {
  createRun,
  resolveSandRun,
  createInferenceRun,
  createChatServiceRun,
  createAgentRun,
  getModels,
  getModelCatalog,
  getSandUsage,
  getHardLimit,
  getTimeLeft,
  getSandStatus,
  settledOrError,
  generateChecksum,
  readableError,
  errorDetail,
  buildHeaders,
  buildInferenceRequest,
  partText,
};
