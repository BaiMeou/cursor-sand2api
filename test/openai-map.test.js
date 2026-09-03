const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const map = require("../src/openai-map");

describe("parseClientToolLine", () => {
  it("parses nested CLIENT_TOOL json", () => {
    const text = 'CLIENT_TOOL {"name":"search_web","arguments":{"query":"kimi","opts":{"n":3}}}';
    const r = map.parseClientToolLine(text);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].type, "function");
    assert.equal(r.calls[0].function.name, "search_web");
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { query: "kimi", opts: { n: 3 } });
    assert.equal(r.cleaned, "");
  });

  it("parses invoke_client_tool without leaking the marker", () => {
    const text = 'invoke_client_tool {"name":"scrape_web","arguments":{"url":"https://example.com"}}';
    const r = map.parseClientToolLine(text);
    assert.equal(r.calls[0].function.name, "scrape_web");
    assert.equal(r.cleaned, "");
  });

  it("parses fenced json tool call", () => {
    const text = '```json\n{"name":"search_web","arguments":{"query":"hi"}}\n```';
    const r = map.parseClientToolLine(text);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "search_web");
  });
});

describe("extractTrailingToolResults", () => {
  it("takes consecutive trailing tool messages", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "search_web" } }] },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
      { role: "tool", tool_call_id: "call_2", content: "second" },
    ];
    const r = map.extractTrailingToolResults(messages);
    assert.equal(r.length, 2);
    assert.equal(r[0].tool_call_id, "call_1");
    assert.equal(r[1].tool_call_id, "call_2");
  });

  it("accepts legacy role=function", () => {
    const r = map.extractTrailingToolResults([
      { role: "user", content: "x" },
      { role: "function", name: "search_web", content: "ok" },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].tool_call_id, "search_web");
  });
});

describe("publicToolCall", () => {
  it("emits OpenAI tool_calls shape", () => {
    const c = map.publicToolCall(
      {
        id: "call_abc",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"a.txt"}' },
      },
      0
    );
    assert.deepEqual(c, {
      id: "call_abc",
      type: "function",
      index: 0,
      function: { name: "read_file", arguments: '{"path":"a.txt"}' },
    });
  });
});
