const { v4: uuidv4 } = require("uuid");

function newCompletionId() {
  return `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
}

class ChatStream {
  constructor(res, { model, includeUsage = false, id, created } = {}) {
    this.res = res;
    this.model = model;
    this.includeUsage = includeUsage;
    this.id = id || newCompletionId();
    this.created = created || Math.floor(Date.now() / 1000);
    this.contentSent = false;
    this.reasoningSent = false;
    this.ended = false;
  }

  _write(payload) {
    if (!this.res || this.res.writableEnded || this.ended) return;
    this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  chunk(delta, finishReason = null, extra = {}) {
    const body = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: delta || {},
          finish_reason: finishReason,
          logprobs: null,
        },
      ],
    };
    if (extra.usage) body.usage = extra.usage;
    this._write(body);
  }

  role() {
    this.chunk({ role: "assistant", content: "" });
  }

  content(text) {
    if (!text) return;
    this.contentSent = true;
    this.chunk({ content: text });
  }

  reasoning(text) {
    if (!text) return;
    this.reasoningSent = true;
    // Both spellings: OpenAI-compat relays and OpenWebUI read reasoning_content;
    // some gateways only look at `reasoning`.
    this.chunk({ reasoning_content: text, reasoning: text });
  }

  reasoningSignature(signature, parts) {
    if (!signature && !(parts && parts.length)) return;
    const delta = {};
    if (signature) delta.reasoning_signature = signature;
    if (parts && parts.length) delta.reasoning_parts = parts;
    this.chunk(delta);
  }

  toolCalls(calls) {
    (calls || []).forEach((c, index) => {
      this.chunk({
        tool_calls: [
          {
            index: c.index != null ? c.index : index,
            id: c.id,
            type: "function",
            function: {
              name: c.function?.name || "",
              arguments: c.function?.arguments || "{}",
            },
          },
        ],
      });
    });
  }

  // Both OpenAI SDKs scan stream frames for a top-level `error` key and raise on
  // it. Writing the failure into delta.content and closing with "stop" instead
  // makes a broken turn look like a finished one: the SDK returns normally, an
  // agent loop reasons about the error text as if the model said it, and a
  // relay bills it as a success rather than failing over.
  error(message, type = "api_error", code = "upstream_error", extra = {}) {
    if (this.ended) return;
    const error = { message: String(message || "upstream error"), type, code };
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (v == null || v === "" || k === "param" || k === "status") continue;
        if (error[k] !== undefined) continue;
        error[k] = v;
      }
    }
    this._write({ error });
    if (this.res && !this.res.writableEnded) this.res.write("data: [DONE]\n\n");
    this.ended = true;
    try {
      this.res.end();
    } catch {}
  }

  // Split out so a dialect that reuses the lifecycle can restate the frame in
  // its own object type without reimplementing finish().
  _usageOnlyFrame(usage) {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  finish(reason, usage) {
    if (this.ended) return;
    this.chunk({}, reason || "stop", usage ? { usage } : {});
    if (this.includeUsage) this._write(this._usageOnlyFrame(usage));
    if (this.res && !this.res.writableEnded) this.res.write("data: [DONE]\n\n");
    this.ended = true;
    try {
      this.res.end();
    } catch {}
  }
}

// A streaming /v1/completions request used to receive chat.completion.chunk
// frames, because only the non-streaming half of that facade was ever
// translated. A caller parsing the legacy dialect finds no `text` key there and
// reads the whole answer as empty.
class TextCompletionStream extends ChatStream {
  constructor(res, options = {}) {
    super(res, options);
    this.id = this.id.replace(/^chatcmpl-/, "cmpl-");
  }

  chunk(delta, finishReason = null, extra = {}) {
    const body = {
      id: this.id,
      object: "text_completion",
      created: this.created,
      model: this.model,
      choices: [{ text: (delta && delta.content) || "", index: 0, logprobs: null, finish_reason: finishReason }],
    };
    if (extra.usage) body.usage = extra.usage;
    this._write(body);
  }

  _usageOnlyFrame(usage) {
    return {
      id: this.id,
      object: "text_completion",
      created: this.created,
      model: this.model,
      choices: [],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  // The legacy shape has no role and no reasoning field. Thinking stays in
  // reasoning_content on the chat dialect and is omitted here on purpose.
  role() {}

  reasoning() {}
}

// Incremental onThinking already wrote reasoning chunks. If the upstream only
// handed us thinking at the end, dump it once here so the stream is not mute.
function flushAssistantStream(stream, fields) {
  if (!stream) return;
  const reasoning = fields && fields.reasoning_content;
  if (reasoning && !stream.reasoningSent) stream.reasoning(reasoning);
  const content = fields && fields.content;
  if (content && !stream.contentSent) stream.content(content);
  if (fields && fields.tool_calls) stream.toolCalls(fields.tool_calls);
}

function parseSseContent(raw) {
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  let finish = null;
  let usage = null;
  let id = null;
  for (const line of String(raw || "").split(/\n/)) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      continue;
    }
    if (obj.id) id = obj.id;
    if (obj.usage) usage = obj.usage;
    const choice = obj.choices && obj.choices[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    else if (d.reasoning) reasoning += d.reasoning;
    if (Array.isArray(d.tool_calls)) toolCalls.push(...d.tool_calls);
  }
  return { id, content, reasoning, toolCalls, finish, usage };
}

module.exports = { ChatStream, TextCompletionStream, newCompletionId, parseSseContent, flushAssistantStream };
