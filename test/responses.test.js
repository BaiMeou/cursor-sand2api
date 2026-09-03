const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const responses = require("../src/responses-protocol");
const { ResponseStream, parseResponseStream } = require("../src/responses-sse");
const { TextCompletionStream } = require("../src/openai-sse");
const converter = require("../src/converter");

function collect() {
  const chunks = [];
  return {
    chunks,
    text: () => chunks.join(""),
    res: {
      writableEnded: false,
      write(s) {
        chunks.push(s);
      },
      end() {
        this.writableEnded = true;
      },
    },
  };
}

describe("responses input translation", () => {
  it("takes a bare string as the user turn", () => {
    assert.deepEqual(responses.inputToMessages("hi"), [{ role: "user", content: "hi" }]);
  });

  it("passes message items through with their content parts intact", () => {
    const parts = [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,x" }];
    const out = responses.inputToMessages([{ type: "message", role: "user", content: parts }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
    // openai-map and the attachment collectors already read these shapes, so
    // rewriting them here would only lose the image.
    assert.deepEqual(out[0].content, parts);
  });

  it("accepts the shorthand item with a role but no type", () => {
    assert.deepEqual(responses.inputToMessages([{ role: "user", content: "hey" }]), [
      { role: "user", content: "hey" },
    ]);
  });

  it("gathers loose content parts into one implicit user turn", () => {
    const out = responses.inputToMessages([
      { type: "input_text", text: "a" },
      { type: "input_text", text: "b" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
    assert.equal(out[0].content.length, 2);
  });

  it("folds parallel function_call items into one assistant turn", () => {
    const out = responses.inputToMessages([
      { type: "message", role: "user", content: "go" },
      { type: "function_call", call_id: "call_a", name: "f", arguments: '{"x":1}' },
      { type: "function_call", call_id: "call_b", name: "g", arguments: "{}" },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[1].role, "assistant");
    assert.equal(out[1].tool_calls.length, 2);
    assert.deepEqual(
      out[1].tool_calls.map((c) => c.id),
      ["call_a", "call_b"]
    );
    assert.equal(out[1].tool_calls[0].function.name, "f");
  });

  it("turns function_call_output into a tool message keyed by call_id", () => {
    const out = responses.inputToMessages([
      { type: "function_call", call_id: "call_a", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: "42" },
    ]);
    const tool = out[out.length - 1];
    assert.equal(tool.role, "tool");
    assert.equal(tool.tool_call_id, "call_a");
    assert.equal(tool.content, "42");
  });

  // extractTrailingToolResults walks backwards off the end, so a replayed round
  // only resumes the parked stream if the results really are the last messages.
  it("leaves tool results trailing so a parked turn can be resumed", () => {
    const map = require("../src/openai-map");
    const out = responses.inputToMessages([
      { type: "message", role: "user", content: "go" },
      { type: "function_call", call_id: "call_a", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: "done" },
    ]);
    assert.deepEqual(map.extractTrailingToolResults(out), [{ tool_call_id: "call_a", content: "done" }]);
  });

  it("starts a new assistant turn after a result rather than reopening the old one", () => {
    const out = responses.inputToMessages([
      { type: "function_call", call_id: "call_a", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: "1" },
      { type: "function_call", call_id: "call_b", name: "g", arguments: "{}" },
    ]);
    const assistants = out.filter((m) => m.role === "assistant");
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0].tool_calls.length, 1);
    assert.equal(assistants[1].tool_calls[0].id, "call_b");
  });

  it("reads a structured function_call_output", () => {
    assert.equal(responses.outputToText([{ type: "output_text", text: "a" }]), "a");
    assert.equal(responses.outputToText({ ok: true }), '{"ok":true}');
    assert.equal(responses.outputToText("plain"), "plain");
  });

  // These are the model's own scratch space handed back. Rendering them as user
  // text would put words in the caller's mouth.
  it("drops reasoning and item_reference items", () => {
    const out = responses.inputToMessages([
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "hmm" }] },
      { type: "item_reference", id: "msg_1" },
    ]);
    assert.deepEqual(out, []);
  });

  it("never leaves the internal turn marker on a message", () => {
    const out = responses.inputToMessages([
      { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
      { type: "function_call_output", call_id: "c", output: "x" },
    ]);
    for (const m of out) assert.equal(Object.hasOwn(m, "__closed"), false);
  });
});

describe("responses request translation", () => {
  it("maps instructions onto a leading system turn", () => {
    const chat = responses.responsesToChat({ model: "m", instructions: "be brief", input: "hi" });
    assert.equal(chat.messages[0].role, "system");
    assert.equal(chat.messages[0].content, "be brief");
    assert.equal(chat.messages[1].role, "user");
  });

  it("renames max_output_tokens and reasoning.effort", () => {
    const chat = responses.responsesToChat({
      input: "hi",
      max_output_tokens: 64,
      reasoning: { effort: "low" },
    });
    assert.equal(chat.max_tokens, 64);
    assert.equal(chat.reasoning_effort, "low");
  });

  it("moves text.format back to response_format", () => {
    const chat = responses.responsesToChat({
      input: "hi",
      text: { format: { type: "json_schema", name: "out", schema: { type: "object" }, strict: true } },
    });
    assert.equal(chat.response_format.type, "json_schema");
    assert.equal(chat.response_format.json_schema.name, "out");
    assert.deepEqual(chat.response_format.json_schema.schema, { type: "object" });
    assert.equal(chat.response_format.json_schema.strict, true);
  });

  it("re-nests a function tool_choice the way chat spells it", () => {
    assert.deepEqual(responses.toolChoiceToChat({ type: "function", name: "f" }), {
      type: "function",
      function: { name: "f" },
    });
    assert.equal(responses.toolChoiceToChat("required"), "required");
    assert.equal(responses.toolChoiceToChat(undefined), undefined);
  });

  // openai-map resolves `t.function?.name || t.name`, so the flat Responses
  // tool already works and must not be rewrapped.
  it("keeps flat function tools and drops hosted ones", () => {
    const tools = [
      { type: "function", name: "f", parameters: {} },
      { type: "web_search" },
    ];
    assert.deepEqual(responses.toolsToChat(tools), [{ type: "function", name: "f", parameters: {} }]);
    assert.deepEqual(responses.hostedTools(tools), ["web_search"]);
  });

  it("carries previous_response_id as the conversation to resume", () => {
    const chat = responses.responsesToChat({ input: "hi", previous_response_id: "conv-1" });
    assert.equal(chat.conversation_id, "conv-1");
  });

  it("produces a body the chat validator accepts", () => {
    const protocol = require("../src/openai-protocol");
    assert.equal(protocol.validateChatRequest(responses.responsesToChat({ input: "hi" })), null);
    // An input of nothing but reasoning items still has to reach the model.
    const onlyReasoning = responses.responsesToChat({ input: [{ type: "reasoning", summary: [] }] });
    assert.equal(protocol.validateChatRequest(onlyReasoning), null);
  });
});

describe("responses request validation", () => {
  it("refuses background mode instead of pretending it queued", () => {
    const bad = responses.validateResponsesRequest({ input: "hi", background: true });
    assert.equal(bad.error.code, "not_implemented");
    assert.equal(bad.error.param, "background");
  });

  it("refuses hosted tools it cannot run", () => {
    const bad = responses.validateResponsesRequest({ input: "hi", tools: [{ type: "file_search" }] });
    assert.equal(bad.error.code, "not_implemented");
    assert.match(bad.error.message, /file_search/);
  });

  it("requires some input", () => {
    assert.equal(responses.validateResponsesRequest({ input: "" }).error.param, "input");
    assert.equal(responses.validateResponsesRequest({ input: [] }).error.param, "input");
    // instructions alone is a legitimate request.
    assert.equal(responses.validateResponsesRequest({ instructions: "go" }), null);
  });

  it("accepts an ordinary request", () => {
    assert.equal(responses.validateResponsesRequest({ input: "hi", tools: [{ type: "function", name: "f" }] }), null);
  });
});

describe("responses usage", () => {
  it("renames every field and nests the details", () => {
    const usage = responses.usageFrom({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      reasoningTokens: 2,
    });
    assert.equal(usage.input_tokens, 10);
    assert.equal(usage.output_tokens, 4);
    assert.equal(usage.total_tokens, 14);
    assert.equal(usage.input_tokens_details.cached_tokens, 3);
    assert.equal(usage.output_tokens_details.reasoning_tokens, 2);
    // The chat spellings must not leak through.
    assert.equal(usage.prompt_tokens, undefined);
    assert.equal(usage.completion_tokens, undefined);
  });

  it("always reports the detail blocks, even at zero", () => {
    const usage = responses.usageFrom(null);
    assert.equal(usage.input_tokens_details.cached_tokens, 0);
    assert.equal(usage.output_tokens_details.reasoning_tokens, 0);
  });
});

describe("non-streaming response body", () => {
  function build(extra = {}) {
    const chat = converter.buildChatResponse("hello", "m", 3, 2, extra);
    return responses.toResponse(chat, "m", { usageDetails: { inputTokens: 3, outputTokens: 2 } });
  }

  it("wraps the answer in a message item", () => {
    const body = build();
    assert.equal(body.object, "response");
    assert.equal(body.status, "completed");
    assert.match(body.id, /^resp_/);
    const message = body.output.find((i) => i.type === "message");
    assert.equal(message.role, "assistant");
    assert.equal(message.content[0].type, "output_text");
    assert.equal(message.content[0].text, "hello");
  });

  it("mirrors the text into output_text for thin clients", () => {
    assert.equal(build().output_text, "hello");
  });

  it("emits reasoning as its own item ahead of the message", () => {
    const body = build({ thinking: "thought" });
    assert.equal(body.output[0].type, "reasoning");
    assert.equal(body.output[0].summary[0].text, "thought");
    assert.equal(body.output[1].type, "message");
  });

  it("turns tool calls into function_call items carrying call_id", () => {
    const chat = converter.buildChatResponse("", "m", 1, 1, {
      toolCalls: [{ id: "call_a", type: "function", function: { name: "f", arguments: '{"x":1}' } }],
    });
    const body = responses.toResponse(chat, "m", {});
    const call = body.output.find((i) => i.type === "function_call");
    assert.equal(call.call_id, "call_a");
    assert.equal(call.name, "f");
    assert.equal(call.arguments, '{"x":1}');
    assert.match(call.id, /^fc_/);
  });

  it("reports a truncated answer as incomplete rather than completed", () => {
    const chat = converter.buildChatResponse("cut", "m", 1, 1, { usageDetails: { cutReason: "length" } });
    const body = responses.toResponse(chat, "m", {});
    assert.equal(body.status, "incomplete");
    assert.equal(body.incomplete_details.reason, "max_output_tokens");
  });

  // Nothing persists the body, so claiming otherwise would promise a retrieval
  // endpoint that answers 501.
  it("answers store honestly as false", () => {
    assert.equal(responses.toResponse(converter.buildChatResponse("x", "m", 1, 1), "m", {
      request: { store: true },
    }).store, false);
  });

  it("echoes the request's own knobs back", () => {
    const body = responses.toResponse(converter.buildChatResponse("x", "m", 1, 1), "m", {
      request: { instructions: "be brief", temperature: 0.5, previous_response_id: "resp_old", metadata: { k: "v" } },
    });
    assert.equal(body.instructions, "be brief");
    assert.equal(body.temperature, 0.5);
    assert.equal(body.previous_response_id, "resp_old");
    assert.deepEqual(body.metadata, { k: "v" });
  });
});

describe("ResponseStream", () => {
  it("opens with created and in_progress exactly once", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.role();
    s.role();
    const { types } = parseResponseStream(text());
    assert.deepEqual(types, ["response.created", "response.in_progress"]);
  });

  it("writes named events, not anonymous data frames", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.content("hi");
    assert.match(text(), /^event: response\.created\ndata: \{/);
    // The chat dialect's terminator has no place here.
    assert.doesNotMatch(text(), /\[DONE\]/);
  });

  it("runs the full item lifecycle around streamed text", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.content("Hel");
    s.content("lo");
    s.finish("stop", { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    const out = parseResponseStream(text());
    assert.deepEqual(out.types, [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.equal(out.content, "Hello");
    assert.equal(out.final.output_text, "Hello");
    assert.equal(out.final.usage.input_tokens, 1);
    assert.equal(out.final.usage.output_tokens, 2);
  });

  it("numbers every event monotonically from zero", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.reasoning("t");
    s.content("a");
    s.finish("stop");
    const { sequences } = parseResponseStream(text());
    assert.deepEqual(sequences, sequences.map((_, i) => i));
  });

  it("closes the reasoning item before opening the message", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.reasoning("thinking");
    s.content("answer");
    s.finish("stop");
    const out = parseResponseStream(text());
    assert.equal(out.reasoning, "thinking");
    assert.equal(out.content, "answer");
    const done = out.events.filter((e) => e.type === "response.output_item.done");
    assert.deepEqual(done.map((e) => e.item.type), ["reasoning", "message"]);
    // Two items means two slots, and they must not both claim index 0.
    assert.deepEqual(done.map((e) => e.output_index), [0, 1]);
    assert.deepEqual(out.final.output.map((i) => i.type), ["reasoning", "message"]);
  });

  it("emits each tool call as its own function_call item", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.toolCalls([
      { id: "call_a", function: { name: "f", arguments: '{"x":1}' } },
      { id: "call_b", function: { name: "g", arguments: "{}" } },
    ]);
    s.finish("tool_calls");
    const out = parseResponseStream(text());
    assert.deepEqual(out.toolCalls.map((c) => c.call_id), ["call_a", "call_b"]);
    assert.deepEqual(out.toolCalls.map((c) => c.arguments), ['{"x":1}', "{}"]);
    const args = out.events.filter((e) => e.type === "response.function_call_arguments.done");
    assert.equal(args.length, 2);
    assert.equal(args[0].arguments, '{"x":1}');
    assert.deepEqual(out.final.output.map((i) => i.type), ["function_call", "function_call"]);
  });

  it("keeps text and tool calls in separate slots on the same turn", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.content("calling");
    s.toolCalls([{ id: "call_a", function: { name: "f", arguments: "{}" } }]);
    s.finish("tool_calls");
    const out = parseResponseStream(text());
    assert.deepEqual(out.final.output.map((i) => i.type), ["message", "function_call"]);
    const indices = out.events.filter((e) => e.type === "response.output_item.done").map((e) => e.output_index);
    assert.deepEqual(indices, [0, 1]);
  });

  it("reports a truncated turn as response.incomplete", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.content("cut");
    s.finish("length");
    const out = parseResponseStream(text());
    assert.ok(out.types.includes("response.incomplete"));
    assert.equal(out.final.status, "incomplete");
    assert.equal(out.final.incomplete_details.reason, "max_output_tokens");
  });

  // A failure has to look like one: the SDKs raise on a bare `error` event, and
  // response.failed alone would let a broken turn resolve as a success.
  it("fails loudly with both response.failed and a raisable error event", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.content("partial");
    s.error("upstream exploded", "api_error", "upstream_error");
    const out = parseResponseStream(text());
    assert.ok(out.types.includes("response.failed"));
    assert.equal(out.error.type, "error");
    assert.equal(out.error.message, "upstream exploded");
    assert.equal(out.error.code, "upstream_error");
    const failed = out.events.find((e) => e.type === "response.failed").response;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.message, "upstream exploded");
    assert.equal(res.writableEnded, true);
  });

  it("closes the open item before failing so the partial answer is not orphaned", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.content("partial");
    s.error("boom");
    const out = parseResponseStream(text());
    assert.equal(out.content, "partial");
    assert.ok(out.types.includes("response.output_item.done"));
  });

  it("writes nothing more once it has ended", () => {
    const { res, text } = collect();
    const s = new ResponseStream(res, { model: "m" });
    s.finish("stop");
    const before = text().length;
    s.content("late");
    s.finish("stop");
    s.error("late");
    assert.equal(text().length, before);
  });

  it("tracks contentSent the way server.js expects", () => {
    const { res } = collect();
    const s = new ResponseStream(res, { model: "m" });
    assert.equal(s.contentSent, false);
    s.content("x");
    assert.equal(s.contentSent, true);
  });
});

describe("TextCompletionStream", () => {
  function frames(raw) {
    return String(raw)
      .split("\n\n")
      .map((l) => l.replace(/^data: /, "").trim())
      .filter((l) => l && l !== "[DONE]")
      .map((l) => JSON.parse(l));
  }

  // A streaming /v1/completions used to answer in the chat dialect, where a
  // legacy client finds no `text` key and reads the answer as empty.
  it("speaks the legacy dialect instead of chat chunks", () => {
    const { res, text } = collect();
    const s = new TextCompletionStream(res, { model: "m" });
    s.role();
    s.content("hello");
    s.finish("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    const out = frames(text());
    for (const f of out) assert.equal(f.object, "text_completion");
    assert.equal(out[0].choices[0].text, "hello");
    assert.match(out[0].id, /^cmpl-/);
    assert.equal(out[out.length - 1].choices[0].finish_reason, "stop");
  });

  it("still terminates with [DONE] like the dialect it belongs to", () => {
    const { res, text } = collect();
    const s = new TextCompletionStream(res, { model: "m" });
    s.content("x");
    s.finish("stop");
    assert.match(text(), /data: \[DONE\]/);
  });

  it("keeps the usage-only frame in its own object type", () => {
    const { res, text } = collect();
    const s = new TextCompletionStream(res, { model: "m", includeUsage: true });
    s.content("x");
    s.finish("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    const last = frames(text()).pop();
    assert.equal(last.object, "text_completion");
    assert.deepEqual(last.choices, []);
    assert.equal(last.usage.total_tokens, 2);
  });
});
