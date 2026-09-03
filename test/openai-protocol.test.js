const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const protocol = require("../src/openai-protocol");
const { ChatStream, parseSseContent } = require("../src/openai-sse");
const { partText } = require("../src/cursor-client");
const map = require("../src/openai-map");

describe("finalizeAssistantFields", () => {
  it("keeps thinking in reasoning_content instead of promoting it into content", () => {
    const f = protocol.finalizeAssistantFields({ text: "", thinking: "pong", toolCalls: null });
    assert.equal(f.content, "");
    assert.equal(f.promoted, false);
    assert.equal(f.reasoning_content, "pong");
  });

  it("does not copy thinking into content when the turn also has tool_calls", () => {
    const f = protocol.finalizeAssistantFields({
      text: "",
      thinking: "I should call get_weather",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
    });
    assert.equal(f.content, null);
    assert.equal(f.promoted, false);
    assert.equal(f.reasoning_content, "I should call get_weather");
    assert.equal(f.tool_calls.length, 1);
  });

  it("keeps tool_calls with null content when there is no thinking either", () => {
    const f = protocol.finalizeAssistantFields({
      text: "",
      thinking: "",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } }],
    });
    assert.equal(f.content, null);
    assert.equal(f.promoted, false);
    assert.equal(f.tool_calls.length, 1);
  });

  it("prefers visible text over thinking", () => {
    const f = protocol.finalizeAssistantFields({ text: "hello", thinking: "secret", toolCalls: null });
    assert.equal(f.content, "hello");
    assert.equal(f.reasoning_content, "secret");
    assert.equal(f.promoted, false);
  });
});

describe("stream flush keeps thinking visible", () => {
  const { ChatStream, parseSseContent, flushAssistantStream } = require("../src/openai-sse");
  const converter = require("../src/converter");

  it("writes leftover reasoning_content when onThinking never fired", () => {
    const chunks = [];
    const res = { writableEnded: false, write(s) { chunks.push(s); }, end() {} };
    const s = new ChatStream(res, { model: "kimi-k3-max" });
    s.role();
    const fields = protocol.finalizeAssistantFields({ text: "pong", thinking: "let me think", toolCalls: null });
    flushAssistantStream(s, fields);
    s.finish("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    const parsed = parseSseContent(chunks.join(""));
    assert.equal(parsed.content, "pong");
    assert.equal(parsed.reasoning, "let me think");
  });

  it("does not dump thinking twice if it already streamed", () => {
    const chunks = [];
    const res = { writableEnded: false, write(s) { chunks.push(s); }, end() {} };
    const s = new ChatStream(res, { model: "kimi-k3-max" });
    s.role();
    s.reasoning("let me think");
    const fields = protocol.finalizeAssistantFields({ text: "pong", thinking: "let me think", toolCalls: null });
    flushAssistantStream(s, fields);
    s.finish("stop");
    const parsed = parseSseContent(chunks.join(""));
    assert.equal(parsed.reasoning, "let me think");
    assert.equal(parsed.content, "pong");
  });

  it("keeps reasoning_content on the non-stream body next to content", () => {
    const body = converter.buildChatResponse("pong", "kimi-k3-max", 1, 2, { thinking: "secret" });
    assert.equal(body.choices[0].message.content, "pong");
    assert.equal(body.choices[0].message.reasoning_content, "secret");
    assert.equal(body.choices[0].message.reasoning, "secret");
  });
});

describe("thinking part shapes", () => {
  it("reads text, delta, and nested thinking fields", () => {
    assert.equal(partText({ text: "a" }), "a");
    assert.equal(partText({ delta: "b" }), "b");
    assert.equal(partText({ thinking: "c" }), "c");
    assert.equal(partText({ textDelta: "d" }), "d");
    assert.equal(partText({ text: { text: "e" } }), "e");
    assert.equal(partText(null), "");
  });
});

describe("validateChatRequest", () => {
  it("requires messages", () => {
    const missing = protocol.validateChatRequest({});
    assert.equal(missing.error.param, "messages");
    assert.equal(missing.error.type, "invalid_request_error");
    const empty = protocol.validateChatRequest({ messages: [] });
    assert.equal(empty.error.param, "messages");
  });

  it("rejects n>1", () => {
    const r = protocol.validateChatRequest({
      n: 2,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(r.error.param, "n");
    assert.equal(r.error.code, "unsupported_parameter");
    assert.equal(r.error.type, "invalid_request_error");
  });

  it("accepts a one-completion chat body", () => {
    assert.equal(
      protocol.validateChatRequest({ messages: [{ role: "user", content: "hi" }] }),
      null
    );
  });
});

describe("legacy functions", () => {
  it("maps functions to tools", () => {
    const tools = protocol.normalizeTools({ functions: [{ name: "get_weather", parameters: { type: "object" } }] });
    assert.equal(tools[0].type, "function");
    assert.equal(tools[0].function.name, "get_weather");
  });
});

describe("ChatStream id stability", () => {
  it("reuses one chatcmpl id", () => {
    const chunks = [];
    const res = {
      writableEnded: false,
      write(s) {
        chunks.push(s);
      },
      end() {},
    };
    const s = new ChatStream(res, { model: "kimi-k3-max" });
    s.role();
    s.reasoning("think");
    s.content("hi");
    s.finish("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    const parsed = parseSseContent(chunks.join(""));
    assert.equal(parsed.content, "hi");
    assert.equal(parsed.reasoning, "think");
    assert.equal(parsed.finish, "stop");
    const ids = [...chunks.join("").matchAll(/"id":"(chatcmpl-[^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length > 1);
    assert.ok(ids.every((id) => id === ids[0]));
  });
});

describe("client-only tools prompt", () => {
  it("forbids tool calls when the caller registered none", () => {
    const p = map.extraToolsPrompt([], "");
    assert.match(p, /HARD RULE/);
    assert.match(p, /every tool call is rejected/i);
    assert.doesNotMatch(p, /OpenAI Chat Completions converter/);
    assert.match(p, /plain text/i);
  });

  // The exec names only mean something next to a CLIENT TOOLS section that says
  // which of them are live. Alone, the model read the list as its own inventory
  // and argued with the line saying it had no tools.
  it("names no built-in tools when there is no CLIENT TOOLS section", () => {
    const p = map.extraToolsPrompt([], "");
    assert.doesNotMatch(p, /CLIENT TOOLS/);
    for (const name of map.BUILTIN_TOOL_NAMES) assert.doesNotMatch(p, new RegExp(name));
  });

  it("still forbids the Cursor built-ins by name once client tools exist", () => {
    const p = map.extraToolsPrompt([{ type: "function", function: { name: "f" } }], "");
    assert.match(p, /MUST NOT use Cursor built-in/);
    assert.match(p, /Shell/);
  });

  it("keeps web search usable on a turn with no client tools", () => {
    const p = map.extraToolsPrompt([], "", false, true);
    assert.match(p, /WebSearch and WebFetch ARE available/);
    assert.match(p, /Every other tool call is rejected/i);
  });

  it("lists only client tools", () => {
    const p = map.extraToolsPrompt([
      { type: "function", function: { name: "search_web", description: "web", parameters: { type: "object" } } },
    ]);
    assert.match(p, /CLIENT TOOLS/);
    assert.match(p, /search_web/);
    assert.match(p, /Never substitute a Cursor built-in/);
  });
});

describe("textToolsPrompt", () => {
  it("only lists caller functions and the Anthropic XML call format", () => {
    const p = map.textToolsPrompt([
      {
        type: "function",
        function: {
          name: "search_web",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      },
    ]);
    assert.match(p, /search_web/);
    assert.match(p, /function_calls/);
    assert.match(p, /<invoke name=/);
    assert.doesNotMatch(p, /HARD RULE|Cursor|Shell|converter|CLIENT TOOLS|backslashes|invoke_client_tool/i);
  });

  it("is empty when there are no functions", () => {
    assert.equal(map.textToolsPrompt([]), "");
  });
});

describe("parseClientToolLine keeps leftover prose", () => {
  it("does not wipe unrelated text", () => {
    const r = map.parseClientToolLine('Here is the weather.\ninvoke_client_tool {"name":"get_weather","arguments":{"city":"Taipei"}}');
    assert.equal(r.calls[0].function.name, "get_weather");
    assert.match(r.cleaned, /Here is the weather/);
  });
});
