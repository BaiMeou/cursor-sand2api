// The Responses stream is a different wire format from chat chunks: named SSE
// events, a monotonic sequence_number, and output modelled as items that open
// and close rather than one anonymous frame repeated. There is no [DONE].
//
// The method names deliberately match ChatStream (role / content / reasoning /
// toolCalls / finish / error, plus contentSent), because server.js drives the
// stream through that interface and should not have to know which dialect it
// is speaking.

const responses = require("./responses-protocol");

// Cursor hands over a tool call complete, never argument-by-argument, so the
// delta below carries the whole string at once. That is spec-legal ??a client
// concatenating deltas ends up with the same arguments ??just not incremental.
class ResponseStream {
  constructor(res, { model, request = {}, id, created } = {}) {
    this.res = res;
    this.model = model;
    this.request = request;
    this.id = id || responses.newId("resp");
    this.created = created || Math.floor(Date.now() / 1000);
    this.sequence = 0;
    this.outputIndex = 0;
    this.output = [];
    this.openItem = null;
    this.contentSent = false;
    this.reasoningSent = false;
    this.started = false;
    this.ended = false;
  }

  _write(type, payload) {
    if (!this.res || this.res.writableEnded || this.ended) return;
    const body = { type, sequence_number: this.sequence++, ...payload };
    this.res.write(`event: ${type}\ndata: ${JSON.stringify(body)}\n\n`);
  }

  _snapshot(status, extra = {}) {
    return responses.buildResponse({
      id: this.id,
      model: this.model,
      output: extra.output || this.output,
      usage: extra.usage,
      request: this.request,
      status,
      extra: { created: this.created, conversationId: extra.conversationId },
    });
  }

  // Emitted once, lazily, so a failure that arrives before the first token can
  // still be reported as a real HTTP status instead of inside a live stream.
  role() {
    if (this.started) return;
    this.started = true;
    this._write("response.created", { response: this._snapshot("in_progress") });
    this._write("response.in_progress", { response: this._snapshot("in_progress") });
  }

  // Items cannot overlap, so an arriving kind that differs from the open one
  // closes it first. Thinking and prose interleaving therefore produces two
  // items rather than a malformed single one.
  _ensure(kind) {
    if (this.openItem && this.openItem.kind === kind) return this.openItem;
    this._close();
    this.role();
    const index = this.outputIndex;
    if (kind === "reasoning") {
      const item = { type: "reasoning", id: responses.newId("rs"), summary: [] };
      this._write("response.output_item.added", { output_index: index, item });
      this._write("response.reasoning_summary_part.added", {
        item_id: item.id,
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      });
      this.openItem = { kind, index, id: item.id, text: "" };
      return this.openItem;
    }
    const item = {
      type: "message",
      id: responses.newId("msg"),
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    this._write("response.output_item.added", { output_index: index, item });
    this._write("response.content_part.added", {
      item_id: item.id,
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    this.openItem = { kind, index, id: item.id, text: "" };
    return this.openItem;
  }

  _close() {
    const open = this.openItem;
    if (!open) return;
    this.openItem = null;
    this.outputIndex += 1;
    if (open.kind === "reasoning") {
      const item = responses.reasoningItem(open.text, open.id);
      this._write("response.reasoning_summary_text.done", {
        item_id: open.id,
        output_index: open.index,
        summary_index: 0,
        text: open.text,
      });
      this._write("response.reasoning_summary_part.done", {
        item_id: open.id,
        output_index: open.index,
        summary_index: 0,
        part: { type: "summary_text", text: open.text },
      });
      this._write("response.output_item.done", { output_index: open.index, item });
      this.output.push(item);
      return;
    }
    const item = responses.messageItem(open.text, open.id);
    this._write("response.output_text.done", {
      item_id: open.id,
      output_index: open.index,
      content_index: 0,
      text: open.text,
    });
    this._write("response.content_part.done", {
      item_id: open.id,
      output_index: open.index,
      content_index: 0,
      part: { type: "output_text", text: open.text, annotations: [] },
    });
    this._write("response.output_item.done", { output_index: open.index, item });
    this.output.push(item);
  }

  content(text) {
    if (!text || this.ended) return;
    this.contentSent = true;
    const open = this._ensure("message");
    open.text += text;
    this._write("response.output_text.delta", {
      item_id: open.id,
      output_index: open.index,
      content_index: 0,
      delta: text,
    });
  }

  reasoning(text) {
    if (!text || this.ended) return;
    this.reasoningSent = true;
    const open = this._ensure("reasoning");
    open.text += text;
    this._write("response.reasoning_summary_text.delta", {
      item_id: open.id,
      output_index: open.index,
      summary_index: 0,
      delta: text,
    });
  }

  toolCalls(calls) {
    if (this.ended) return;
    if (!(calls || []).length) return;
    this.role();
    this._close();
    for (const call of calls) {
      const index = this.outputIndex;
      const item = responses.functionCallItem(call);
      const opening = { ...item, arguments: "", status: "in_progress" };
      this._write("response.output_item.added", { output_index: index, item: opening });
      this._write("response.function_call_arguments.delta", {
        item_id: item.id,
        output_index: index,
        delta: item.arguments,
      });
      this._write("response.function_call_arguments.done", {
        item_id: item.id,
        output_index: index,
        arguments: item.arguments,
      });
      this._write("response.output_item.done", { output_index: index, item });
      this.output.push(item);
      this.outputIndex += 1;
    }
  }

  // A failure has to look like a failure. The SDKs raise on a bare `error`
  // event; response.failed alone would let a broken turn resolve normally and
  // be billed as a success by anything relaying it.
  error(message, type = "api_error", code = "upstream_error", extra = {}) {
    if (this.ended) return;
    this.role();
    this._close();
    const body = { code, message: String(message || "upstream error"), param: null };
    if (extra && typeof extra === "object") {
      for (const [k, v] of Object.entries(extra)) {
        if (v == null || v === "" || body[k] !== undefined || k === "type") continue;
        body[k] = v;
      }
    }
    const failed = this._snapshot("failed");
    failed.error = { ...body, type };
    this._write("response.failed", { response: failed });
    this._write("error", body);
    this.ended = true;
    try {
      this.res.end();
    } catch {}
  }

  finish(reason, usage) {
    if (this.ended) return;
    this.role();
    this._close();
    const status = responses.statusFor(reason);
    const snapshot = this._snapshot(status, { usage: responses.usageFromChat(usage) });
    this._write(status === "incomplete" ? "response.incomplete" : "response.completed", {
      response: snapshot,
    });
    this.ended = true;
    try {
      this.res.end();
    } catch {}
  }
}

// Test helper: reassembles a Responses stream the way parseSseContent does for
// chat, so a suite can assert on the outcome instead of the frame sequence.
function parseResponseStream(raw) {
  const events = [];
  let content = "";
  let reasoning = "";
  const toolCalls = [];
  let final = null;
  let error = null;

  for (const block of String(raw || "").split(/\n\n/)) {
    const dataLine = block.split(/\n/).find((l) => l.startsWith("data: "));
    if (!dataLine) continue;
    let obj;
    try {
      obj = JSON.parse(dataLine.slice(6));
    } catch {
      continue;
    }
    events.push(obj);
    if (obj.type === "response.output_text.delta") content += obj.delta || "";
    if (obj.type === "response.reasoning_summary_text.delta") reasoning += obj.delta || "";
    if (obj.type === "response.output_item.done" && obj.item && obj.item.type === "function_call") {
      toolCalls.push(obj.item);
    }
    if (obj.type === "response.completed" || obj.type === "response.incomplete") final = obj.response;
    if (obj.type === "error") error = obj;
  }
  const types = events.map((e) => e.type);
  const sequences = events.map((e) => e.sequence_number);
  return { events, types, sequences, content, reasoning, toolCalls, final, error };
}

module.exports = { ResponseStream, parseResponseStream };
