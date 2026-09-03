// InferenceService/Stream is unary server-streaming. Tool results cannot be
// written back on the same HTTP/2 stream; the next turn re-POSTs history.
// Field names follow proto3 JSON (camelCase) as spoken by connect+json.

const { v4: uuidv4 } = require("uuid");
const { formatAnthropicInvokes, formatAnthropicResults } = require("./tool-parse");
const { CUSTOM_TOOL_FORMAT } = require("./claude-tools");
const { sandTextToolsOnly } = require("./model-family");

const INFERENCE_ROLE = { user: 1, assistant: 2, tool: 3, system: 4 };

function slugWantsMax(modelId) {
  return /-(thinking-)?(max|xhigh)(?:-fast)?$/i.test(String(modelId || ""))
    || /-(max|xhigh)-thinking(?:-fast)?$/i.test(String(modelId || ""));
}

function textFromRoot(entry) {
  const content = entry && entry.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === "text" && p.text) parts.push(p.text);
    else if (typeof p === "string") parts.push(p);
  }
  return parts.join("\n");
}

function asStruct(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
    return { _raw: value };
  }
  return {};
}

// google.protobuf.Value over connect+json is the JSON value itself.
function asProtoValue(raw) {
  if (raw == null) return "";
  if (typeof raw === "object") return raw;
  const s = String(raw);
  const t = s.trim();
  if (!t) return "";
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return s;
    }
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  return s;
}

function inferenceUserContent(text, images = [], documents = []) {
  const img = Array.isArray(images) ? images.filter((a) => a && a.data) : [];
  const docs = Array.isArray(documents) ? documents.filter((a) => a && a.data) : [];
  if (!img.length && !docs.length) return text ? { text } : null;
  const parts = [];
  if (text) parts.push({ text: { text } });
  for (const a of img) {
    const mime = a.mimeType || a.mime_type;
    const image = { data: a.data };
    if (mime) image.mimeType = mime;
    parts.push({ image });
  }
  for (const a of docs) {
    const file = { data: a.data, mediaType: a.mimeType || "application/octet-stream" };
    if (a.filename || a.path) file.filename = a.filename || a.path;
    parts.push({ file });
  }
  if (!parts.length) return text ? { text } : null;
  return { parts: { parts } };
}

function collectEntryMedia(entry) {
  const images = [];
  const files = [];
  const texts = [];
  const content = entry && entry.content;
  if (typeof content === "string") texts.push(content);
  else if (Array.isArray(content)) {
    for (const p of content) {
      if (!p) continue;
      if (p.type === "text" && p.text) texts.push(p.text);
      else if (typeof p === "string") texts.push(p);
      else if (p.type === "image") images.push(p);
      else if (p.type === "file") files.push(p);
    }
  }
  return { text: texts.join("\n").trim(), images, files };
}

function mapReasoningParts(entry) {
  const list = entry && Array.isArray(entry.reasoningParts) ? entry.reasoningParts : [];
  return list
    .map((p) => {
      if (!p) return null;
      const out = {
        isRedacted: Boolean(p.isRedacted || p.is_redacted),
        text: String(p.text || ""),
      };
      if (p.signature) out.signature = String(p.signature);
      if (p.redactedData || p.redacted_data) out.redactedData = String(p.redactedData || p.redacted_data);
      return out.text || out.signature || out.redactedData ? out : null;
    })
    .filter(Boolean);
}

function mapRootMessage(entry, { textToolsOnly = false } = {}) {
  if (!entry) return null;
  const role = entry.role || "user";
  if (role === "system") {
    const text = textFromRoot(entry).trim();
    return text ? { role: INFERENCE_ROLE.system, text } : null;
  }
  if (role === "user") {
    const media = collectEntryMedia(entry);
    const extra = inferenceUserContent(media.text, media.images, media.files);
    if (!extra) return null;
    return { role: INFERENCE_ROLE.user, ...extra };
  }
  if (role === "assistant") {
    const textParts = [];
    const toolCalls = [];
    for (const p of entry.content || []) {
      if (!p) continue;
      if (p.type === "text" && p.text) textParts.push(p.text);
      else if (p.type === "tool-call") {
        const args = asStruct(p.args);
        const raw =
          typeof p.args === "string" ? p.args : JSON.stringify(args);
        const call = {
          toolCallId: p.toolCallId || p.tool_call_id || "",
          toolName: p.toolName || p.tool_name || "",
          args,
        };
        if (raw) call.rawToolCallArgs = raw;
        toolCalls.push(call);
      }
    }
    const reasoningParts = mapReasoningParts(entry);
    if (textToolsOnly && toolCalls.length) {
      textParts.push(formatAnthropicInvokes(toolCalls));
      const text = textParts.join("\n").trim();
      const msg = text ? { role: INFERENCE_ROLE.assistant, text } : null;
      if (msg && reasoningParts.length) msg.reasoningParts = reasoningParts;
      return msg;
    }
    const msg = { role: INFERENCE_ROLE.assistant };
    const text = textParts.join("\n").trim();
    if (text) msg.text = text;
    if (toolCalls.length) msg.toolCalls = toolCalls;
    if (reasoningParts.length) msg.reasoningParts = reasoningParts;
    if (!msg.text && !msg.toolCalls && !msg.reasoningParts) return null;
    return msg;
  }
  if (role === "tool") {
    const parts = [];
    for (const p of entry.content || []) {
      if (!p || p.type !== "tool-result") continue;
      parts.push({
        toolCallId: p.toolCallId || p.tool_call_id || entry.id || "",
        toolName: p.toolName || p.tool_name || "",
        result: asProtoValue(p.result),
        isError: Boolean(p.isError),
      });
    }
    if (!parts.length) {
      parts.push({
        toolCallId: entry.id || "",
        toolName: "",
        result: asProtoValue(textFromRoot(entry)),
        isError: false,
      });
    }
    if (textToolsOnly) {
      const text = formatAnthropicResults(parts).trim();
      return text ? { role: INFERENCE_ROLE.user, text } : null;
    }
    return { role: INFERENCE_ROLE.tool, toolContent: { parts } };
  }
  return null;
}

const ANTHROPIC_CACHE = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

function applyAnthropicCache(msg) {
  if (!msg) return msg;
  if (typeof msg.text === "string" && msg.text) {
    const text = msg.text;
    delete msg.text;
    msg.parts = {
      parts: [{ text: { text, providerOptions: ANTHROPIC_CACHE } }],
    };
    return msg;
  }
  const parts = msg.parts && msg.parts.parts;
  if (!Array.isArray(parts) || !parts.length) return msg;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (!p || !p.text) continue;
    const text = typeof p.text === "string" ? { text: p.text } : { ...p.text };
    text.providerOptions = ANTHROPIC_CACHE;
    parts[i] = { ...p, text };
    break;
  }
  return msg;
}

// Anthropic-style prompt cache: breakpoint on the stable prefix (system,
// then the last history turn). The active user turn stays uncached.
// ConversationId is minted fresh on Claude XML turns, so cache_control is
// the only prefix that can actually hit.
function stampPrefixCache(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  applyAnthropicCache(messages[0]);
  for (let i = messages.length - 2; i >= 1; i--) {
    const m = messages[i];
    if (m && (typeof m.text === "string" || (m.parts && m.parts.parts && m.parts.parts.length))) {
      applyAnthropicCache(m);
      break;
    }
  }
  return messages;
}

function claudeSandTurn(modelId, textToolsOnly) {
  return Boolean(textToolsOnly || sandTextToolsOnly(modelId));
}

function buildInferenceMessages({
  rootMessages = [],
  userText = "",
  systemText = "",
  prompt = "",
  textToolsOnly = false,
  modelId = "",
  images = [],
  documents = [],
} = {}) {
  const messages = [];
  const sys = String(systemText || "").trim();
  if (sys) messages.push({ role: INFERENCE_ROLE.system, text: sys });
  for (const entry of rootMessages || []) {
    const mapped = mapRootMessage(entry, { textToolsOnly });
    if (mapped) messages.push(mapped);
  }
  const user = String(userText || "").trim();
  const extra = inferenceUserContent(user, images, documents);
  if (extra) messages.push({ role: INFERENCE_ROLE.user, ...extra });
  if (!messages.length) {
    messages.push({ role: INFERENCE_ROLE.user, text: String(prompt || "").trim() || "Hello" });
  }
  // Sand Claude 429s/504s once anthropic cacheControl is stamped, even on
  // no-tool turns, as soon as history makes messages.length >= 2. Send the
  // full transcript; do not drop or digest older turns to "make it fit".
  if (claudeSandTurn(modelId, textToolsOnly)) {
    return textToolsOnly ? coalesceAdjacentTextTurns(messages) : messages;
  }
  return stampPrefixCache(messages);
}

function messagePlainText(m) {
  if (typeof m.text === "string" && m.text) return m.text;
  if (m.parts && Array.isArray(m.parts.parts)) {
    return m.parts.parts.map((p) => (p.text && p.text.text) || "").join("\n");
  }
  return "";
}

// Parallel tool results land as adjacent same-role user turns. Fold those
// together so Cursor sees one turn; do not clip text or drop older history.
function coalesceAdjacentTextTurns(messages) {
  const coalesced = [];
  for (const m of messages) {
    if (!m) continue;
    const text = messagePlainText(m);
    const hasParts = Boolean(m.parts && m.parts.parts && m.parts.parts.length);
    if (m.role !== INFERENCE_ROLE.system && !text.trim() && !hasParts) continue;
    const cur = hasParts ? { ...m } : { role: m.role, text };
    if (m.reasoningParts) cur.reasoningParts = m.reasoningParts;
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.role === cur.role && !prev.parts && !cur.parts && prev.text != null && cur.text != null) {
      prev.text = `${prev.text}\n${cur.text}`;
      continue;
    }
    coalesced.push(cur);
  }
  return coalesced;
}

function buildInferenceTools(openaiTools, names, { xmlFormat = false } = {}) {
  const out = [];
  for (const t of openaiTools || []) {
    const fn = t && (t.function || t);
    if (!fn || !fn.name) continue;
    const name = names && typeof names.wire === "function" ? names.wire(fn.name) : fn.name;
    const tool = {
      name,
      description: fn.description || "",
      parameters:
        fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : { type: "object", properties: {} },
    };
    if (xmlFormat) tool.customToolFormat = CUSTOM_TOOL_FORMAT;
    out.push(tool);
  }
  return out;
}

function looksCompleteJson(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  const wrapped =
    (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
  if (!wrapped) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function isEmptyArgs(s) {
  const t = String(s || "").trim();
  return !t || t === "{}" || t === "[]";
}

function unwrapProtoValue(v) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) return v;
  if ("stringValue" in v || "string_value" in v) return v.stringValue ?? v.string_value;
  if ("numberValue" in v || "number_value" in v) return v.numberValue ?? v.number_value;
  if ("boolValue" in v || "bool_value" in v) return v.boolValue ?? v.bool_value;
  if ("nullValue" in v || "null_value" in v) return null;
  if ("structValue" in v || "struct_value" in v) {
    return flattenProtoStruct(v.structValue ?? v.struct_value);
  }
  if ("listValue" in v || "list_value" in v) {
    const list = v.listValue ?? v.list_value;
    const values = list && Array.isArray(list.values) ? list.values : Array.isArray(list) ? list : [];
    return values.map(unwrapProtoValue);
  }
  if (v.fields && typeof v.fields === "object" && !Array.isArray(v.fields)) {
    return flattenProtoStruct(v);
  }
  return v;
}

function flattenProtoStruct(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const src = raw.fields && typeof raw.fields === "object" && !Array.isArray(raw.fields) ? raw.fields : raw;
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = unwrapProtoValue(v);
  return out;
}

const SEARCH_TOOL_NAME = /^(search_web|web_search|websearch|search)$/i;
const QUERY_ALIASES = ["q", "search_query", "searchQuery", "keywords", "keyword", "text", "value", "input"];
const BORING_USER = /^(continue, using the tool results above\.?|continue\.?|ok|okay)$/i;

function compactQuery(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function messageContentText(msg) {
  if (!msg) return "";
  const content = msg.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (p && p.type === "text" && p.text) return p.text;
      return p && p.text ? p.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function guessSearchQuery({ userText, thinking, messages } = {}) {
  const u = compactQuery(userText);
  if (u && !BORING_USER.test(u)) return u;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || (m.role !== "user" && m.role !== "developer")) continue;
      const t = compactQuery(messageContentText(m));
      if (t && !BORING_USER.test(t)) return t;
    }
  }
  const quoted = String(thinking || "").match(
    /search(?:ing)?(?: the web)?(?: for)?\s+["“]([^"”]{2,80})["”]/i
  );
  if (quoted) return quoted[1].trim();
  return u;
}

function parseArgsObject(raw) {
  if (raw == null || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return flattenProtoStruct(raw);
  const t = String(raw).trim();
  try {
    const parsed = JSON.parse(t);
    if (typeof parsed === "string") return { _string: parsed };
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return flattenProtoStruct(parsed);
    return { value: parsed };
  } catch {
    return { _string: t };
  }
}

function firstNonEmpty(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v == null) continue;
    const s = typeof v === "string" ? v.trim() : String(v).trim();
    if (s) return typeof v === "string" ? v : s;
  }
  return "";
}

function normalizeToolCallArguments(name, argsStr, hint = {}) {
  const obj = parseArgsObject(argsStr);
  if (obj._string) {
    return JSON.stringify(SEARCH_TOOL_NAME.test(name) ? { query: obj._string } : { value: obj._string });
  }
  if (SEARCH_TOOL_NAME.test(name) && !String(obj.query || "").trim()) {
    const aliased = firstNonEmpty(obj, QUERY_ALIASES);
    if (aliased) obj.query = aliased;
    else {
      const guessed = guessSearchQuery(hint);
      if (guessed) obj.query = guessed;
    }
  }
  return JSON.stringify(obj);
}

function normalizeOpenAIToolCalls(calls, hint = {}) {
  return (calls || []).map((c) => {
    if (!c || !c.function) return c;
    return {
      ...c,
      function: {
        ...c.function,
        arguments: normalizeToolCallArguments(c.function.name || "", c.function.arguments, hint),
      },
    };
  });
}

function toolArgsChunk(tool) {
  if (!tool || typeof tool !== "object") return "";
  const raw =
    tool.rawToolCallArgs ??
    tool.raw_tool_call_args ??
    tool.argumentsJson ??
    tool.arguments_json ??
    tool.partialArgs ??
    tool.partial_args ??
    tool.args ??
    tool.arguments ??
    tool.input ??
    tool.delta ??
    null;
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") return JSON.stringify(flattenProtoStruct(raw));
  return String(raw);
}

function mergeArgChunks(prev, chunk) {
  if (!chunk) return prev;
  if (!prev) return chunk;
  // A later empty `{}` / "" must not wipe a snapshot that already had keys.
  // Stream parts often finish with is_complete + empty args; the real JSON
  // arrived earlier or on response_info.tool_calls.
  if (isEmptyArgs(chunk) && !isEmptyArgs(prev)) return prev;
  if (isEmptyArgs(prev) && !isEmptyArgs(chunk)) return chunk;
  if (chunk.startsWith(prev)) return chunk;
  if (prev.startsWith(chunk)) return prev;
  // Two complete JSON snapshots that differ only in whitespace would otherwise
  // concatenate into invalid args. Keep the latest complete object.
  if (looksCompleteJson(chunk)) return chunk;
  return prev + chunk;
}

function toolPartKey(tool, size) {
  const id = tool.toolCallId || tool.tool_call_id || "";
  if (id) return `id:${id}`;
  const idx = tool.toolIndex ?? tool.tool_index;
  if (idx != null && idx !== "") return `idx:${idx}`;
  return `anon:${size}`;
}

function createToolCallAccumulator() {
  const parts = new Map();
  return {
    ingest(tool) {
      if (!tool || typeof tool !== "object") return;
      const name = tool.toolName || tool.tool_name || "";
      const id = tool.toolCallId || tool.tool_call_id || "";
      const chunk = toolArgsChunk(tool);
      const complete = Boolean(tool.isComplete || tool.is_complete);
      if (!name && !id && !chunk && !complete) return;
      let key = toolPartKey(tool, parts.size);
      let rec = parts.get(key);
      if (!rec && id) {
        for (const [k, existing] of parts) {
          if (k.startsWith("anon:") && !existing.id && existing.name && existing.name === name) {
            parts.delete(k);
            existing.id = id;
            parts.set(key, existing);
            rec = existing;
            break;
          }
        }
      }
      if (!rec) {
        rec = { id, name, args: "", complete: false };
        parts.set(key, rec);
      }
      if (id) rec.id = id;
      if (name) rec.name = name;
      if (chunk) rec.args = mergeArgChunks(rec.args, chunk);
      if (complete) rec.complete = true;
    },
    toOpenAICalls(mapName, newId) {
      const out = [];
      for (const rec of parts.values()) {
        if (!rec.name) continue;
        const name = mapName ? mapName(rec.name) : rec.name;
        out.push({
          id: rec.id || (newId ? newId() : `call_${out.length + 1}`),
          type: "function",
          function: {
            name,
            arguments: rec.args || "{}",
          },
        });
      }
      return out;
    },
    size() {
      return parts.size;
    },
  };
}

function ingestResponseInfo(info, acc) {
  if (!info || !acc || typeof acc.ingest !== "function") return;
  const messages = info.messages || [];
  for (const m of messages) {
    for (const call of (m && (m.toolCalls || m.tool_calls)) || []) {
      acc.ingest({ ...call, isComplete: true });
    }
  }
}

function buildInferenceRequest({
  prompt,
  modelId,
  conversationId,
  rootMessages,
  userText,
  systemText,
  openaiTools,
  toolNames,
  toolChoice,
  maxTokens,
  stops,
  temperature,
  topP,
  textToolsOnly = false,
  xmlToolFormat = false,
  images = [],
  documents = [],
  maxMode,
  modelParameters,
} = {}) {
  const tools =
    toolChoice === "none" || textToolsOnly
      ? []
      : buildInferenceTools(openaiTools, toolNames, { xmlFormat: xmlToolFormat });
  const body = {
    messages: buildInferenceMessages({
      rootMessages,
      userText,
      systemText,
      prompt,
      textToolsOnly,
      modelId,
      images,
      documents,
    }),
    requestedModel: { modelId },
    modelId,
  };
  if (maxMode === true || (maxMode == null && slugWantsMax(modelId))) {
    body.requestedModel.maxMode = true;
  }
  if (Array.isArray(modelParameters) && modelParameters.length) {
    body.requestedModel.parameters = modelParameters;
  }
  // Text-tool turns replay the full transcript each POST. Reuse of the
  // caller's conversationId attaches to a stale Inference thread; omitting
  // the field entirely is invalid_argument. Mint a fresh id per request.
  body.conversationId = claudeSandTurn(modelId, textToolsOnly) || !conversationId ? uuidv4() : conversationId;
  if (tools.length) body.tools = tools;
  const modelConfig = {};
  if (maxTokens) modelConfig.maxTokens = maxTokens;
  if (Array.isArray(stops) && stops.length) modelConfig.stopSequences = stops;
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    modelConfig.temperature = temperature;
  }
  if (typeof topP === "number" && Number.isFinite(topP)) modelConfig.topP = topP;
  if (Object.keys(modelConfig).length) body.modelConfig = modelConfig;
  return body;
}

module.exports = {
  INFERENCE_ROLE,
  asStruct,
  asProtoValue,
  mapRootMessage,
  buildInferenceMessages,
  buildInferenceTools,
  createToolCallAccumulator,
  buildInferenceRequest,
  mergeArgChunks,
  toolArgsChunk,
  flattenProtoStruct,
  normalizeToolCallArguments,
  normalizeOpenAIToolCalls,
  guessSearchQuery,
  ingestResponseInfo,
};
