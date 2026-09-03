const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("crypto");

const {
  buildTurnInput,
  historyHasToolTurns,
  createBlobStore,
  SYSTEM_LEAD_IN,
  SYSTEM_ACK,
  DEFAULT_CONTINUATION,
} = require("../src/history");

describe("buildTurnInput", () => {
  it("splits the trailing user turn out of the history", () => {
    const { rootMessages, userText } = buildTurnInput([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
    assert.equal(userText, "third");
    assert.equal(rootMessages.length, 2);
    assert.deepEqual(rootMessages[0], { role: "user", content: [{ type: "text", text: "first" }] });
    assert.equal(rootMessages[1].role, "assistant");
  });

  it("delivers a system message as an opening exchange", () => {
    const { rootMessages } = buildTurnInput([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(rootMessages.length, 2);
    assert.equal(rootMessages[0].role, "user");
    assert.match(rootMessages[0].content[0].text, new RegExp(SYSTEM_LEAD_IN));
    assert.match(rootMessages[0].content[0].text, /be terse/);
    assert.deepEqual(rootMessages[1], {
      role: "assistant",
      content: [{ type: "text", text: SYSTEM_ACK }],
    });
  });

  it("keeps a real system role when systemAsHistory is off", () => {
    const { rootMessages } = buildTurnInput(
      [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
      { systemAsHistory: false }
    );
    assert.deepEqual(rootMessages, [{ role: "system", content: "be terse" }]);
  });

  it("treats developer like system", () => {
    const { rootMessages, userText } = buildTurnInput([
      { role: "developer", content: "policy" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(userText, "hi");
    assert.equal(rootMessages[0].role, "user");
    assert.match(rootMessages[0].content[0].text, /policy/);
  });

  it("carries assistant tool_calls as tool-call parts with parsed args", () => {
    const { rootMessages } = buildTurnInput([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Osaka"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", name: "get_weather", content: '{"temp_c":31}' },
    ]);
    const assistant = rootMessages.find((m) => m.role === "assistant");
    assert.deepEqual(assistant.content, [
      { type: "tool-call", toolCallId: "call_1", toolName: "get_weather", args: { city: "Osaka" } },
    ]);
    const tool = rootMessages.find((m) => m.role === "tool");
    assert.equal(tool.id, "call_1");
    assert.equal(tool.content[0].type, "tool-result");
    assert.equal(tool.content[0].result, '{"temp_c":31}');
    assert.equal(tool.content[0].toolName, "get_weather");
  });

  it("recovers the tool name from the call when the result omits it", () => {
    const { rootMessages } = buildTurnInput([
      { role: "user", content: "go" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "search_web", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "hits" },
    ]);
    const tool = rootMessages.find((m) => m.role === "tool");
    assert.equal(tool.content[0].toolName, "search_web");
  });

  it("marks a tool result that carries an error", () => {
    const { rootMessages } = buildTurnInput([
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: '{"error":"boom"}' },
      { role: "assistant", tool_calls: [{ id: "c2", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c2", content: '{"ok":true}' },
    ]);
    const tools = rootMessages.filter((m) => m.role === "tool");
    assert.equal(tools[0].content[0].isError, true);
    assert.equal(tools[1].content[0].isError, undefined);
  });

  it("drives the follow-up with a continuation turn when history ends on a tool result", () => {
    const { rootMessages, userText } = buildTurnInput([
      { role: "user", content: "weather?" },
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "w", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
    ]);
    assert.equal(userText, DEFAULT_CONTINUATION);
    assert.equal(rootMessages.length, 3);
    assert.equal(rootMessages[0].role, "user");
  });

  it("honours a custom continuation prompt", () => {
    const { userText } = buildTurnInput(
      [{ role: "tool", tool_call_id: "c1", content: "x" }],
      { continuationPrompt: "go on" }
    );
    assert.equal(userText, "go on");
  });

  it("keeps an empty tool result rather than orphaning its call", () => {
    const { rootMessages } = buildTurnInput([
      { role: "assistant", tool_calls: [{ id: "c1", function: { name: "w", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "" },
    ]);
    const tool = rootMessages.find((m) => m.role === "tool");
    assert.equal(tool.content[0].result, "");
  });

  it("accepts legacy role=function as a tool result", () => {
    const { rootMessages } = buildTurnInput([
      { role: "user", content: "hi" },
      { role: "function", name: "f", content: "done" },
    ]);
    assert.equal(rootMessages[rootMessages.length - 1].role, "tool");
  });

  it("flattens array content and marks dropped images", () => {
    const { userText } = buildTurnInput([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ],
      },
    ]);
    assert.match(userText, /look/);
    assert.match(userText, /image omitted/);
  });

  it("returns no user text when the caller sent only assistant history", () => {
    const { userText } = buildTurnInput([{ role: "assistant", content: "hello" }]);
    assert.equal(userText, "");
  });

  it("survives an empty message list", () => {
    assert.deepEqual(buildTurnInput([]), { rootMessages: [], userText: "" });
    assert.deepEqual(buildTurnInput(undefined), { rootMessages: [], userText: "" });
  });
});

describe("historyHasToolTurns", () => {
  it("sees OpenAI tool_calls and tool results", () => {
    assert.equal(historyHasToolTurns([{ role: "user", content: "hi" }]), false);
    assert.equal(
      historyHasToolTurns([
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "x", arguments: "{}" } }] },
      ]),
      true
    );
    assert.equal(historyHasToolTurns([{ role: "tool", tool_call_id: "c1", content: "ok" }]), true);
  });
});

describe("blob store", () => {
  it("keys entries by the base64 sha256 of their JSON bytes", () => {
    const store = createBlobStore();
    const entry = { role: "user", content: [{ type: "text", text: "hi" }] };
    const id = store.put(entry);
    const expected = createHash("sha256")
      .update(Buffer.from(JSON.stringify(entry), "utf8"))
      .digest()
      .toString("base64");
    assert.equal(id, expected);
    assert.deepEqual(JSON.parse(Buffer.from(store.get(id), "base64").toString("utf8")), entry);
  });

  it("deduplicates identical entries", () => {
    const store = createBlobStore();
    const a = store.put({ role: "user", content: "x" });
    const b = store.put({ role: "user", content: "x" });
    assert.equal(a, b);
    assert.equal(store.size(), 1);
  });

  it("looks up an id given as a Buffer", () => {
    const store = createBlobStore();
    const id = store.put({ role: "user", content: "x" });
    assert.equal(store.get(Buffer.from(id, "base64")), store.get(id));
  });

  it("finds a blob when the server echoes the id URL-safe or unpadded", () => {
    const store = createBlobStore();
    // A payload whose digest contains both + and / in standard base64.
    let id = "";
    for (let i = 0; !/[+/]/.test(id); i++) id = store.put({ role: "user", content: `probe-${i}` });
    const urlSafe = id.replace(/\+/g, "-").replace(/\//g, "_");
    assert.notEqual(urlSafe, id);
    assert.equal(store.get(urlSafe), store.get(id));
    assert.equal(store.get(urlSafe.replace(/=+$/, "")), store.get(id));
  });

  it("returns undefined for an unknown id", () => {
    const store = createBlobStore();
    assert.equal(store.get("bm9wZQ=="), undefined);
    assert.equal(store.get(""), undefined);
  });
});
