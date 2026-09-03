const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseTextToolCalls } = require("../src/tool-parse");
const map = require("../src/openai-map");

describe("parseTextToolCalls", () => {
  it("parses Anthropic function_calls XML", () => {
    const r = parseTextToolCalls(
      'ok\n<function_calls>\n<invoke name="get_weather">\n<parameter name="city">Osaka</parameter>\n</invoke>\n</function_calls>',
      { protocolTurn: true }
    );
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { city: "Osaka" });
    assert.equal(r.cleaned, "");
  });

  it("parses <tool_use> XML", () => {
    const r = parseTextToolCalls(
      '<tool_use><name>search_web</name><input>{"query":"kimi"}</input></tool_use>'
    );
    assert.equal(r.calls[0].function.name, "search_web");
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { query: "kimi" });
  });

  it("keeps the old invoke_client_tool line", () => {
    const r = parseTextToolCalls(
      'Here.\ninvoke_client_tool {"name":"get_weather","arguments":{"city":"Taipei"}}'
    );
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { city: "Taipei" });
    assert.match(r.cleaned, /Here/);
  });

  it("parses Hermes <tool_call> JSON", () => {
    const r = parseTextToolCalls(
      'thinking\n<tool_call>{"name":"search_web","arguments":{"query":"kimi"}}</tool_call>'
    );
    assert.equal(r.calls[0].function.name, "search_web");
    assert.equal(r.cleaned, "thinking");
  });

  it("parses <function name> XML", () => {
    const r = parseTextToolCalls('<function name="get_weather">{"city":"Osaka"}</function>');
    assert.equal(r.calls[0].function.name, "get_weather");
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { city: "Osaka" });
  });

  it("ignores a fenced JSON example that is not an allowed tool", () => {
    const r = parseTextToolCalls('```json\n{"name":"not_a_tool","arguments":{"q":1}}\n```', {
      allowed: new Set(["get_weather"]),
    });
    assert.equal(r.calls.length, 0);
    assert.match(r.cleaned, /not_a_tool/);
  });

  it("harvests an allowed fenced call", () => {
    const r = parseTextToolCalls('```json\n{"name":"get_weather","arguments":{"city":"Kyoto"}}\n```', {
      allowed: ["get_weather"],
    });
    assert.equal(r.calls.length, 1);
    assert.equal(r.cleaned, "");
  });

  it("does not harvest when tool_choice is none", () => {
    const r = parseTextToolCalls(
      'invoke_client_tool {"name":"get_weather","arguments":{}}',
      { toolChoice: "none" }
    );
    assert.equal(r.calls.length, 0);
  });

  it("maps the wire name back for the OpenAI caller", () => {
    const r = parseTextToolCalls(
      'invoke_client_tool {"name":"Read_","arguments":{"path":"a.txt"}}',
      { allowed: new Set(["Read", "Read_"]), mapName: (n) => (n === "Read_" ? "Read" : n) }
    );
    assert.equal(r.calls[0].function.name, "Read");
  });

  it("parses a Windows path whose backslashes are invalid JSON escapes", () => {
    const text =
      'invoke_client_tool {"name":"list_dir","arguments":{"path":"C:\\Users\\example\\Documents\\lk"}}';
    const r = parseTextToolCalls(text, { allowed: ["list_dir"] });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "list_dir");
    assert.equal(JSON.parse(r.calls[0].function.arguments).path, "C:\\Users\\example\\Documents\\lk");
  });

  it("drops leftover chatter on a protocol turn so the call is not shown as prose", () => {
    const text =
      '先看目录。\ninvoke_client_tool {"name":"list_dir","arguments":{"path":"C:/lk"}}\n让本小姐并行操作。';
    const r = parseTextToolCalls(text, { protocolTurn: true });
    assert.equal(r.calls.length, 1);
    assert.equal(r.cleaned, "");
  });

  it("keeps leftover chatter when it is not a protocol turn", () => {
    const text =
      'Here is the weather.\ninvoke_client_tool {"name":"get_weather","arguments":{"city":"Taipei"}}';
    const r = parseTextToolCalls(text);
    assert.equal(r.calls.length, 1);
    assert.match(r.cleaned, /Here is the weather/);
  });

  it("keeps an explicit invoke line even if the name is not in the allow list", () => {
    const r = parseTextToolCalls(
      'invoke_client_tool {"name":"list_dir","arguments":{"path":"C:/Users/example/Documents/lk"}}',
      { allowed: ["search_web"] }
    );
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "list_dir");
  });

  it("parses Name{json} when that name is one of the listed functions", () => {
    const text =
      'Bash{"command":"ls -la /c/Users/example/Documents/lk","description":"List working directory contents"}';
    const r = parseTextToolCalls(text, { allowed: ["Bash", "Agent"], protocolTurn: true });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "Bash");
    assert.equal(JSON.parse(r.calls[0].function.arguments).command, "ls -la /c/Users/example/Documents/lk");
    assert.equal(r.cleaned, "");
  });

  it("parses Name{json} even when inner quotes break strict JSON", () => {
    const text =
      'Bash{"command":"ls -la "/c/Users/example/Documents/lk"","description":"List working directory contents"}';
    const r = parseTextToolCalls(text, { allowed: ["Bash"] });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "Bash");
    const args = JSON.parse(r.calls[0].function.arguments);
    assert.match(args.command, /Documents\/lk/);
  });

  it("parses a labeled Bash command followed by a shell line", () => {
    const text =
      "我先来了解一下环境和这两个项目的位置。\n\n  Bash命令：列出下载目录内容\n\n  ls -la /c/Users/example/Downloads/ 2>/dev/null | head -50\n";
    const r = parseTextToolCalls(text, { allowed: ["Bash"], protocolTurn: true });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "Bash");
    const args = JSON.parse(r.calls[0].function.arguments);
    assert.match(args.command, /Downloads/);
    assert.equal(args.description, "列出下载目录内容");
    assert.equal(r.cleaned, "");
  });

  it("does not treat random code braces as a call", () => {
    const r = parseTextToolCalls('if (true) { return 1; }', { allowed: ["Bash"] });
    assert.equal(r.calls.length, 0);
  });

  it("keeps a write_file call when invoke_client_tool appears inside file contents", () => {
    const inner = 'invoke_client_tool {"name":"search_web","arguments":{"query":"nested"}}';
    const args = JSON.stringify({ path: "note.md", contents: inner });
    const text = `invoke_client_tool {"name":"write_file","arguments":${args}}`;
    const r = parseTextToolCalls(text, { allowed: ["write_file", "search_web"] });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].function.name, "write_file");
    assert.equal(JSON.parse(r.calls[0].function.arguments).contents, inner);
  });
});

describe("parseClientToolLine still delegates", () => {
  it("parses nested CLIENT_TOOL json", () => {
    const r = map.parseClientToolLine(
      'CLIENT_TOOL {"name":"search_web","arguments":{"query":"kimi","opts":{"n":3}}}'
    );
    assert.equal(r.calls[0].function.name, "search_web");
    assert.deepEqual(JSON.parse(r.calls[0].function.arguments), { query: "kimi", opts: { n: 3 } });
  });
});
