const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const map = require("../src/openai-map");

function tools(...names) {
  return names.map((name) => ({ type: "function", function: { name, parameters: {} } }));
}

describe("tool name collisions with Cursor builtins", () => {
  it("normalises camelCase and dashes the way Cursor does", () => {
    assert.equal(map.normalizeToolName("WebSearch"), "web_search");
    assert.equal(map.normalizeToolName("Read"), "read");
    assert.equal(map.normalizeToolName("web-fetch"), "web_fetch");
    assert.equal(map.normalizeToolName("get_weather"), "get_weather");
  });

  it("suffixes a name that would claim a builtin", () => {
    const names = map.toolNameMap(tools("Read", "WebSearch", "get_weather"));
    assert.equal(names.wire("Read"), "Read_");
    assert.equal(names.wire("WebSearch"), "WebSearch_");
    assert.equal(names.wire("get_weather"), "get_weather");
  });

  it("avoids colliding with another declared tool while escaping", () => {
    const names = map.toolNameMap(tools("Read", "Read_"));
    // Read must escape the builtin, and Read_ is already taken by its neighbour.
    assert.equal(names.wire("Read"), "Read__");
    // Read_ does not normalise onto a builtin, so it travels untouched.
    assert.equal(names.wire("Read_"), "Read_");
    assert.equal(names.caller("Read__"), "Read");
    assert.equal(names.caller("Read_"), "Read_");
  });

  it("maps the wire name back, including model paraphrases", () => {
    const names = map.toolNameMap(tools("WebSearch"));
    assert.equal(names.caller("WebSearch_"), "WebSearch");
    assert.equal(names.caller("WebSearch"), "WebSearch");
    assert.equal(names.caller("web_search"), "WebSearch");
    assert.equal(names.caller("unrelated"), "unrelated");
  });

  it("declares the escaped name upstream", () => {
    const defs = map.buildMcpToolDefinitions(tools("Read", "get_weather"));
    assert.equal(defs[0].name, "Read_");
    assert.equal(defs[0].toolName, "Read_");
    assert.equal(defs[1].name, "get_weather");
  });

  it("hands the caller back its own name for an mcpArgs exec", () => {
    const names = map.toolNameMap(tools("WebSearch"));
    const call = map.execToToolCall(
      { mcpArgs: { toolName: "WebSearch_", args: { query: "taipei" }, toolCallId: "tc_1" } },
      names
    );
    assert.equal(call.function.name, "WebSearch");
    assert.equal(call.id, "tc_1");
    assert.deepEqual(JSON.parse(call.function.arguments), { query: "taipei" });
  });

  it("leaves names alone when nothing collides", () => {
    const names = map.toolNameMap(tools("get_weather", "search_web"));
    assert.equal(names.wire("get_weather"), "get_weather");
    assert.equal(names.caller("get_weather"), "get_weather");
  });
});
