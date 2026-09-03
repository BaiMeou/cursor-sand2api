const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const history = require("../src/history");
const map = require("../src/openai-map");
const {
  INFERENCE_ROLE,
  buildInferenceMessages,
  buildInferenceTools,
  buildInferenceRequest,
  createToolCallAccumulator,
  mergeArgChunks,
  ingestResponseInfo,
  asProtoValue,
  toolArgsChunk,
  flattenProtoStruct,
  normalizeToolCallArguments,
  normalizeOpenAIToolCalls,
} = require("../src/inference-protocol");

function messageText(m) {
  if (!m) return "";
  if (typeof m.text === "string") return m.text;
  if (m.parts && Array.isArray(m.parts.parts)) {
    return m.parts.parts.map((p) => (p.text && p.text.text) || "").join("");
  }
  return "";
}

const weatherTool = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Weather lookup",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  },
};

describe("buildInferenceMessages", () => {
  it("falls back to a single user turn when there is no history", () => {
    const messages = buildInferenceMessages({ prompt: "Reply with exactly: pong" });
    assert.deepEqual(messages, [{ role: INFERENCE_ROLE.user, text: "Reply with exactly: pong" }]);
  });

  it("puts the converter prefix on system and the active turn on user", () => {
    const messages = buildInferenceMessages({
      systemText: "<client_runtime>native</client_runtime>",
      userText: "weather in Osaka?",
    });
    assert.equal(messages[0].role, INFERENCE_ROLE.system);
    assert.equal(messages[1].role, INFERENCE_ROLE.user);
    assert.equal(messages[1].text, "weather in Osaka?");
    assert.equal(
      messages[0].parts.parts[0].text.providerOptions.anthropic.cacheControl.type,
      "ephemeral"
    );
    assert.equal(typeof messages[1].text, "string");
  });

  it("does not put cache_control on a lone user turn", () => {
    const messages = buildInferenceMessages({ userText: "hi" });
    assert.deepEqual(messages, [{ role: INFERENCE_ROLE.user, text: "hi" }]);
  });

  it("skips anthropic cache on sand Claude even without advertised tools", () => {
    const messages = buildInferenceMessages({
      modelId: "claude-fable-5-1-thinking-high",
      systemText: "be concise",
      userText: "pong",
    });
    assert.equal(messages[0].role, INFERENCE_ROLE.system);
    assert.equal(messages[1].role, INFERENCE_ROLE.user);
    assert.equal(JSON.stringify(messages).includes("cacheControl"), false);
  });

  it("keeps a long Claude transcript intact and only skips cache", () => {
    const rootMessages = [];
    for (let i = 0; i < 40; i++) {
      rootMessages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn-${i}` }],
      });
    }
    const messages = buildInferenceMessages({
      modelId: "claude-fable-5-1",
      rootMessages,
      userText: "湛江天气",
    });
    assert.equal(messages.length, 41);
    assert.equal(messageText(messages[0]), "turn-0");
    assert.equal(messageText(messages[39]), "turn-39");
    assert.equal(messageText(messages[40]), "湛江天气");
    assert.equal(JSON.stringify(messages).includes("cacheControl"), false);
  });

  it("does not stamp cache_control on Claude text-tool turns", () => {
    const messages = buildInferenceMessages({
      systemText: "Functions:\n- get_weather",
      userText: "weather in Osaka?",
      textToolsOnly: true,
    });
    assert.equal(messages[0].role, INFERENCE_ROLE.system);
    assert.equal(messages[0].text, "Functions:\n- get_weather");
    assert.equal(messages[1].role, INFERENCE_ROLE.user);
    assert.equal(messages[1].text, "weather in Osaka?");
    assert.equal(messages[0].parts, undefined);
    assert.equal(JSON.stringify(messages).includes("cacheControl"), false);
  });

  it("maps assistant tool-calls and tool results from buildTurnInput", () => {
    const { rootMessages, userText } = history.buildTurnInput([
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
    const messages = buildInferenceMessages({
      rootMessages,
      userText,
      systemText: "use tools",
    });
    assert.equal(messages[0].role, INFERENCE_ROLE.system);
    assert.equal(messages[1].role, INFERENCE_ROLE.user);
    assert.equal(messageText(messages[1]), "weather?");
    assert.equal(messages[2].role, INFERENCE_ROLE.assistant);
    assert.equal(messages[2].toolCalls[0].toolCallId, "call_1");
    assert.equal(messages[2].toolCalls[0].toolName, "get_weather");
    assert.deepEqual(messages[2].toolCalls[0].args, { city: "Osaka" });
    assert.equal(messages[3].role, INFERENCE_ROLE.tool);
    assert.equal(messages[3].toolContent.parts[0].toolCallId, "call_1");
    assert.deepEqual(messages[3].toolContent.parts[0].result, { temp_c: 31 });
    assert.equal(messages[4].role, INFERENCE_ROLE.user);
    assert.equal(messages[4].text, history.DEFAULT_CONTINUATION);
  });
});

describe("buildInferenceTools", () => {
  it("declares OpenAI functions as InferenceAgentTool structs", () => {
    const tools = buildInferenceTools([weatherTool]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "get_weather");
    assert.equal(tools[0].description, "Weather lookup");
    assert.deepEqual(tools[0].parameters.required, ["city"]);
  });

  it("rewrites names that collide with Cursor builtins", () => {
    const names = map.toolNameMap([{ type: "function", function: { name: "WebSearch" } }]);
    const tools = buildInferenceTools(
      [{ type: "function", function: { name: "WebSearch", parameters: { type: "object" } } }],
      names
    );
    assert.equal(tools[0].name, "WebSearch_");
  });
});

describe("buildInferenceRequest", () => {
  it("omits tools when tool_choice is none", () => {
    const body = buildInferenceRequest({
      prompt: "hi",
      modelId: "kimi-k3-max",
      conversationId: "c1",
      userText: "hi",
      openaiTools: [weatherTool],
      toolChoice: "none",
    });
    assert.equal(body.tools, undefined);
    assert.equal(body.modelId, "kimi-k3-max");
    assert.deepEqual(body.requestedModel, { modelId: "kimi-k3-max", maxMode: true });
  });

  it("does not stamp cache_control on a textToolsOnly system+user request", () => {
    const body = buildInferenceRequest({
      modelId: "claude-sonnet-5",
      systemText: "Functions:\n- get_weather",
      userText: "weather in Osaka?",
      openaiTools: [weatherTool],
      textToolsOnly: true,
    });
    assert.equal(body.messages[0].role, INFERENCE_ROLE.system);
    assert.equal(body.messages[0].text, "Functions:\n- get_weather");
    assert.equal(body.messages[1].role, INFERENCE_ROLE.user);
    assert.equal(body.messages[1].text, "weather in Osaka?");
    assert.equal(JSON.stringify(body.messages).includes("cacheControl"), false);
  });

  it("omits the proto tools field and flattens history for text-only tool families", () => {
    const { rootMessages } = history.buildTurnInput([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"Osaka"}' } }],
      },
      { role: "tool", tool_call_id: "c1", name: "get_weather", content: '{"temp_c":31}' },
    ], { continuationPrompt: "" });
    const body = buildInferenceRequest({
      modelId: "claude-sonnet-5",
      conversationId: "c1",
      rootMessages,
      openaiTools: [weatherTool],
      textToolsOnly: true,
    });
    assert.equal(body.tools, undefined);
    const roles = body.messages.map((m) => m.role);
    assert.ok(!roles.includes(INFERENCE_ROLE.tool));
    const assistant = body.messages.find((m) => m.role === INFERENCE_ROLE.assistant);
    assert.match(messageText(assistant), /<function_calls>/);
    assert.match(messageText(assistant), /<invoke name="get_weather">/);
    assert.match(messageText(assistant), /Osaka/);
    assert.equal(assistant.toolCalls, undefined);
    const result = body.messages.find(
      (m) => m.role === INFERENCE_ROLE.user && /function_results/.test(m.text || "")
    );
    assert.ok(result);
    assert.match(result.text, /31/);
  });

  it("merges adjacent user turns from parallel tool results", () => {
    const { rootMessages } = history.buildTurnInput([
      { role: "user", content: "look up both" },
      {
        role: "assistant",
        tool_calls: [
          { id: "c1", function: { name: "a", arguments: "{}" } },
          { id: "c2", function: { name: "b", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", name: "a", content: "A" },
      { role: "tool", tool_call_id: "c2", name: "b", content: "B" },
    ], { continuationPrompt: "" });
    const body = buildInferenceRequest({
      modelId: "claude-sonnet-5",
      conversationId: "c1",
      rootMessages,
      textToolsOnly: true,
    });
    const users = body.messages.filter((m) => m.role === INFERENCE_ROLE.user);
    assert.equal(users.length, 2);
    assert.match(users[1].text, /function_results/);
    assert.match(users[1].text, /name="a"/);
    assert.match(users[1].text, /name="b"/);
    const roles = body.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1]);
    assert.match(body.conversationId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(body.conversationId, "c1");
  });

  it("mints a fresh conversationId on text-tool requests", () => {
    const a = buildInferenceRequest({
      modelId: "claude-sonnet-5",
      conversationId: "keep-me",
      userText: "hi",
      textToolsOnly: true,
    });
    const b = buildInferenceRequest({
      modelId: "claude-sonnet-5",
      conversationId: "keep-me",
      userText: "hi",
      textToolsOnly: true,
    });
    assert.match(a.conversationId, /^[0-9a-f-]{36}$/i);
    assert.notEqual(a.conversationId, "keep-me");
    assert.notEqual(a.conversationId, b.conversationId);
    const native = buildInferenceRequest({
      modelId: "kimi-k3-max",
      conversationId: "keep-me",
      userText: "hi",
    });
    assert.equal(native.conversationId, "keep-me");
  });

  it("still flattens Claude tool history when the current turn omitted tools", () => {
    const { rootMessages } = history.buildTurnInput([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"Tokyo"}' } }],
      },
      { role: "tool", tool_call_id: "c1", name: "get_weather", content: '{"ok":true}' },
      { role: "user", content: "and now?" },
    ]);
    const body = buildInferenceRequest({
      modelId: "claude-fable-5-1",
      rootMessages,
      userText: "and now?",
      textToolsOnly: true,
    });
    assert.equal(body.tools, undefined);
    assert.ok(!body.messages.some((m) => m.toolCalls || m.toolContent));
    assert.ok(!body.messages.some((m) => m.role === INFERENCE_ROLE.tool));
  });

  it("includes tools, history, and modelConfig together", () => {
    const { rootMessages, userText } = history.buildTurnInput([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"Osaka"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
    ]);
    const body = buildInferenceRequest({
      modelId: "kimi-k3-max",
      conversationId: "c1",
      rootMessages,
      userText,
      systemText: "native tools",
      openaiTools: [weatherTool],
      maxTokens: 128,
      stops: ["END"],
    });
    assert.equal(body.tools.length, 1);
    assert.equal(body.modelConfig.maxTokens, 128);
    assert.deepEqual(body.modelConfig.stopSequences, ["END"]);
    const roles = body.messages.map((m) => m.role);
    assert.deepEqual(roles, [
      INFERENCE_ROLE.system,
      INFERENCE_ROLE.user,
      INFERENCE_ROLE.assistant,
      INFERENCE_ROLE.tool,
      INFERENCE_ROLE.user,
    ]);
  });

  it("puts temperature and top_p on modelConfig", () => {
    const body = buildInferenceRequest({
      modelId: "kimi-k3-max",
      conversationId: "c1",
      userText: "hi",
      temperature: 0.2,
      topP: 0.8,
    });
    assert.equal(body.modelConfig.temperature, 0.2);
    assert.equal(body.modelConfig.topP, 0.8);
  });

  it("sets maxMode on a max slug", () => {
    const body = buildInferenceRequest({
      modelId: "claude-fable-5-1-thinking-max",
      conversationId: "c1",
      userText: "hi",
    });
    assert.equal(body.requestedModel.maxMode, true);
  });

  it("attaches images on the user turn as Inference parts", () => {
    const body = buildInferenceRequest({
      modelId: "kimi-k3-max",
      conversationId: "c1",
      userText: "what colour",
      images: [{ data: "QUJD", mimeType: "image/png" }],
    });
    const last = body.messages[body.messages.length - 1];
    assert.equal(last.text, undefined);
    assert.equal(last.parts.parts[0].text.text, "what colour");
    assert.equal(last.parts.parts[1].image.data, "QUJD");
    assert.equal(last.parts.parts[1].image.mimeType, "image/png");
  });

  it("stamps customToolFormat when asked to", () => {
    const tools = buildInferenceTools([weatherTool], null, { xmlFormat: true });
    assert.equal(tools[0].customToolFormat.syntax, "xml");
  });
});

describe("tool call stream accumulation", () => {
  it("treats a growing args string as a snapshot", () => {
    assert.equal(mergeArgChunks('{"c', '{"city":"O'), '{"city":"O');
    assert.equal(mergeArgChunks('{"city":"Osaka"}', '{"city"'), '{"city":"Osaka"}');
  });

  it("appends a delta that is not a snapshot", () => {
    assert.equal(mergeArgChunks('{"city":"', 'Osaka"}'), '{"city":"Osaka"}');
  });

  it("keeps the latest complete JSON snapshot when whitespace differs", () => {
    assert.equal(
      mergeArgChunks('{"city": "Osaka"}', '{"city":"Osaka"}'),
      '{"city":"Osaka"}'
    );
  });

  it("merges incremental parts for one call and keeps parallel calls apart", () => {
    const acc = createToolCallAccumulator();
    acc.ingest({ toolCallId: "a", toolName: "get_weather", args: '{"c', isComplete: false });
    acc.ingest({ toolCallId: "a", toolName: "get_weather", args: '{"city":"Osaka"}', isComplete: true });
    acc.ingest({ toolCallId: "b", toolName: "get_time", args: "{}", isComplete: true, toolIndex: 1 });
    const calls = acc.toOpenAICalls();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].id, "a");
    assert.equal(calls[0].function.name, "get_weather");
    assert.equal(calls[0].function.arguments, '{"city":"Osaka"}');
    assert.equal(calls[1].id, "b");
    assert.equal(calls[1].function.name, "get_time");
  });

  it("maps wire names back to the caller spelling", () => {
    const names = map.toolNameMap([{ type: "function", function: { name: "WebSearch" } }]);
    const acc = createToolCallAccumulator();
    acc.ingest({ toolCallId: "c1", toolName: "WebSearch_", args: '{"q":"hi"}', isComplete: true });
    const calls = acc.toOpenAICalls((n) => names.caller(n));
    assert.equal(calls[0].function.name, "WebSearch");
  });

  it("accepts snake_case stream fields", () => {
    const acc = createToolCallAccumulator();
    acc.ingest({ tool_call_id: "x", tool_name: "f", args: "{}", is_complete: true });
    const calls = acc.toOpenAICalls();
    assert.equal(calls[0].id, "x");
    assert.equal(calls[0].function.name, "f");
  });

  it("does not let a later empty {} wipe earlier args", () => {
    assert.equal(mergeArgChunks('{"city":"Tokyo"}', "{}"), '{"city":"Tokyo"}');
    const acc = createToolCallAccumulator();
    acc.ingest({ toolCallId: "a", toolName: "get_weather", args: '{"city":"Tokyo"}', isComplete: false });
    acc.ingest({ toolCallId: "a", toolName: "get_weather", args: "{}", isComplete: true });
    const calls = acc.toOpenAICalls();
    assert.equal(calls[0].function.arguments, '{"city":"Tokyo"}');
  });

  it("reads raw_tool_call_args and Struct args from response_info", () => {
    const acc = createToolCallAccumulator();
    acc.ingest({ toolCallId: "a", toolName: "get_weather", args: "", isComplete: true });
    ingestResponseInfo(
      {
        messages: [
          {
            toolCalls: [
              {
                toolCallId: "a",
                toolName: "get_weather",
                rawToolCallArgs: '{"city":"Osaka"}',
              },
            ],
          },
        ],
      },
      acc
    );
    assert.equal(acc.toOpenAICalls()[0].function.arguments, '{"city":"Osaka"}');
  });
});

describe("normalize search_web args", () => {
  it("flattens protobuf Value wrappers without a fields bag", () => {
    assert.deepEqual(flattenProtoStruct({ query: { stringValue: "湛江天气" } }), { query: "湛江天气" });
    assert.equal(toolArgsChunk({ args: { query: { stringValue: "湛江天气" } } }), '{"query":"湛江天气"}');
  });

  it("aliases q onto query", () => {
    assert.equal(normalizeToolCallArguments("search_web", '{"q":"湛江天气"}'), '{"q":"湛江天气","query":"湛江天气"}');
  });

  it("fills an empty Gemini search_web from the user turn", () => {
    assert.equal(
      normalizeToolCallArguments("search_web", "{}", {
        userText: "查一下广东湛江现在的天气，必须调用 search_web。",
      }),
      '{"query":"查一下广东湛江现在的天气，必须调用 search_web。"}'
    );
    const calls = normalizeOpenAIToolCalls(
      [{ id: "c1", type: "function", function: { name: "search_web", arguments: "{}" } }],
      { userText: "湛江天气" }
    );
    assert.equal(calls[0].function.arguments, '{"query":"湛江天气"}');
  });

  it("does not invent a query for a non-search tool", () => {
    assert.equal(normalizeToolCallArguments("get_weather", "{}", { userText: "Osaka" }), "{}");
  });
});

describe("asProtoValue", () => {
  it("keeps JSON objects structured and leaves prose as a string", () => {
    assert.deepEqual(asProtoValue('{"temp_c":31}'), { temp_c: 31 });
    assert.equal(asProtoValue("sunny"), "sunny");
    assert.equal(asProtoValue(""), "");
  });
});
