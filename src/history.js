// Cursor builds the model prompt on its own side from conversation history it
// pulls back over the KV channel, so history travels as structured entries
// keyed by content hash rather than as one flattened user turn. Flattening
// loses role structure and makes every past tool result look like prose the
// user typed.

const { createHash } = require("crypto");
const { collectImages } = require("./image-attach");
const { collectDocuments } = require("./document-attach");

const SYSTEM_LEAD_IN = "Configuration for this session, set by the operator of this API gateway:";
const SYSTEM_ACK = "Understood. I will follow that configuration for the rest of this conversation.";
const DEFAULT_CONTINUATION = "Continue, using the tool results above.";

// `options` only ever describes the active turn: it is the one turn whose
// attachments really are being uploaded, so it is the only one where an
// omission note would contradict what the model receives. History stays text.
function textOf(content, options = {}) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const p of content) {
    if (typeof p === "string") parts.push(p);
    else if (!p) continue;
    else if (p.type === "text" && p.text) parts.push(p.text);
    else if (p.type === "image_url" || p.type === "input_image") {
      if (!options.imagesAttached) parts.push("[image omitted: converter has no vision upload]");
    } else if (p.type === "input_audio") parts.push("[audio omitted]");
    else if (p.type === "file" || p.type === "input_file") {
      if (!options.documentsAttached) {
        const src = (p.file && typeof p.file === "object" ? p.file : p) || {};
        parts.push(`[file omitted: ${src.filename || src.file_id || "attachment"}]`);
      }
    } else if (p.text) parts.push(p.text);
  }
  return parts.join("\n");
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(String(raw));
  } catch {
    return { _raw: String(raw) };
  }
}

function isToolRole(role) {
  return role === "tool" || role === "function";
}

// The active turn is the trailing user message. A caller mid-agent-loop ends on
// a tool result instead, and has no new user text to send.
function activeUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i] && messages[i].role;
    if (role === "user" || role === "developer") return i;
    if (isToolRole(role) || role === "assistant") return -1;
  }
  return -1;
}

function systemEntries(text, systemAsHistory) {
  if (!systemAsHistory) return [{ role: "system", content: text }];
  // Cursor discards a real system role: it composes the model prompt itself and
  // only accepts conversation history. Delivering it as the opening exchange is
  // the closest thing that survives.
  return [
    { role: "user", content: [{ type: "text", text: `${SYSTEM_LEAD_IN}\n\n${text}` }] },
    { role: "assistant", content: [{ type: "text", text: SYSTEM_ACK }] },
  ];
}

function normalizeReasoningParts(msg) {
  if (!msg || typeof msg !== "object") return [];
  if (Array.isArray(msg.reasoning_parts) && msg.reasoning_parts.length) {
    return msg.reasoning_parts
      .map((p) => ({
        text: String((p && (p.text || p.reasoning)) || ""),
        signature: String((p && (p.signature || p.data)) || ""),
        isRedacted: Boolean(p && (p.is_redacted || p.redacted || p.isRedacted)),
      }))
      .filter((p) => p.text || p.signature);
  }
  const sig = msg.reasoning_signature || msg.thinking_signature || "";
  const text = msg.reasoning_content || (typeof msg.reasoning === "string" ? msg.reasoning : "") || "";
  if (sig || String(text).trim()) {
    return [{ text: String(text), signature: String(sig), isRedacted: false }];
  }
  return [];
}

function assistantEntry(msg) {
  const parts = [];
  const text = textOf(msg.content);
  if (text) parts.push({ type: "text", text });
  for (const call of msg.tool_calls || []) {
    parts.push({
      type: "tool-call",
      toolCallId: call.id,
      toolName: (call.function && call.function.name) || call.name || "",
      args: parseArgs(call.function && call.function.arguments),
    });
  }
  const reasoningParts = normalizeReasoningParts(msg);
  if (!parts.length && !reasoningParts.length) return null;
  const entry = { role: "assistant", content: parts };
  if (reasoningParts.length) entry.reasoningParts = reasoningParts;
  return entry;
}

function looksLikeError(text) {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed && typeof parsed === "object" && (parsed.error || parsed.isError));
  } catch {
    return false;
  }
}

function toolEntry(msg, toolNameById) {
  const callId = msg.tool_call_id || msg.toolCallId || "";
  const result = textOf(msg.content);
  // OpenAI tool messages usually carry only tool_call_id, but the AI SDK shape
  // pairs a result with its call by name as well, so recover it from the
  // assistant turn that made the call.
  const part = {
    type: "tool-result",
    toolName: msg.name || toolNameById.get(callId) || "",
    toolCallId: callId,
    result,
  };
  if (looksLikeError(result)) part.isError = true;
  // Emitted even when the result is empty: the matching assistant tool-call is
  // already in history and dropping the pair replays an orphaned call.
  return { role: "tool", id: callId, content: [part] };
}

function historyHasToolTurns(messages) {
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "tool" || m.role === "function") return true;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
    if (Array.isArray(m.content) && m.content.some((p) => p && (p.type === "tool-call" || p.type === "tool-result"))) {
      return true;
    }
  }
  return false;
}

function buildTurnInput(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const systemAsHistory = options.systemAsHistory !== false;
  const continuation =
    options.continuationPrompt == null ? DEFAULT_CONTINUATION : options.continuationPrompt;
  const active = activeUserIndex(list);
  const rootMessages = [];

  const toolNameById = new Map();
  for (const msg of list) {
    for (const call of (msg && msg.tool_calls) || []) {
      const name = (call.function && call.function.name) || call.name;
      if (call.id && name) toolNameById.set(call.id, name);
    }
  }

  for (let i = 0; i < list.length; i++) {
    if (i === active) continue;
    const msg = list[i];
    if (!msg) continue;
    const role = msg.role || "user";

    if (role === "system" || role === "developer") {
      const text = textOf(msg.content);
      if (text) rootMessages.push(...systemEntries(text, systemAsHistory));
      continue;
    }
    if (role === "user") {
      // History data-URLs travel as Inference parts. Placeholders stay only
      // when the bytes could not be attached (remote URL, too large, unknown).
      const raw = Array.isArray(msg.content) ? msg.content : [];
      const imgs = collectImages(raw);
      const docs = collectDocuments(raw);
      const text = textOf(msg.content, {
        imagesAttached: imgs.attachments.length > 0,
        documentsAttached: docs.attachments.length > 0,
      });
      const content = [];
      if (text) content.push({ type: "text", text });
      for (const a of imgs.attachments) content.push({ type: "image", ...a });
      for (const a of docs.attachments) content.push({ type: "file", ...a });
      if (content.length) rootMessages.push({ role: "user", content });
      continue;
    }
    if (role === "assistant") {
      const entry = assistantEntry(msg);
      if (entry) rootMessages.push(entry);
      continue;
    }
    if (isToolRole(role)) rootMessages.push(toolEntry(msg, toolNameById));
  }

  const endsOnToolResult = list.length > 0 && isToolRole(list[list.length - 1].role);
  let userText = "";
  if (active >= 0) {
    userText = textOf(list[active].content, {
      imagesAttached: Boolean(options.imagesAttached),
      documentsAttached: Boolean(options.documentsAttached),
    });
  } else if (endsOnToolResult) userText = continuation;

  return { rootMessages, userText };
}

// Blob ids are the sha256 of the exact bytes that were hashed, sent as base64
// because the proto field is `bytes`. Keys are normalised to hex: proto3 JSON
// only promises standard base64 on the way out and accepts all four variants on
// the way in, and a sha256 averages a couple of `+`/`/` characters — a server
// that echoes the id URL-safe would miss every lookup, and a missed lookup is a
// hard `Blob not found` that kills the whole turn.
function blobKey(id) {
  if (!id) return "";
  if (Buffer.isBuffer(id)) return id.toString("hex");
  return Buffer.from(String(id), "base64").toString("hex");
}

function createBlobStore() {
  const blobs = new Map();
  return {
    put(entry) {
      const data = Buffer.from(JSON.stringify(entry), "utf8");
      const digest = createHash("sha256").update(data).digest();
      blobs.set(digest.toString("hex"), data.toString("base64"));
      return digest.toString("base64");
    },
    get(id) {
      const key = blobKey(id);
      return key ? blobs.get(key) : undefined;
    },
    // The server can also push a blob down mid-turn and read it back later.
    set(id, base64Data) {
      const key = blobKey(id);
      if (key) blobs.set(key, base64Data);
    },
    size() {
      return blobs.size;
    },
  };
}

module.exports = {
  buildTurnInput,
  historyHasToolTurns,
  createBlobStore,
  blobKey,
  textOf,
  SYSTEM_LEAD_IN,
  SYSTEM_ACK,
  DEFAULT_CONTINUATION,
};
