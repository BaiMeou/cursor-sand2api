const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  pickChatTransport,
  INFERENCE,
  CHAT_TOOLS,
  AGENT,
  CHAT_SERVICE_PATH,
  INFERENCE_PATH,
  AGENT_PATH,
  sandRpcPath,
  buildChatServiceRequest,
} = require("../src/chat-transport");
const { familyId } = require("../src/model-family");
const {
  resolveSandRun,
  createInferenceRun,
  createChatServiceRun,
  createAgentRun,
  settledOrError,
} = require("../src/cursor-client");

const opts = { familyId };

describe("pickChatTransport", () => {
  it("assigns Claude to a working ChatService row instead of an exhausted Inference row", () => {
    const matrix = [
      { rpc: "/aiserver.v1.InferenceService/Stream", model: "claude-sonnet-5-thinking-high", classified: "resource_exhausted", contentLen: 0, reasoningLen: 0 },
      { rpc: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools", model: "claude-sonnet-5-thinking-high", classified: "ok", contentLen: 4, reasoningLen: 0 },
      { rpc: "/agent.v1.AgentService/Run", model: "claude-sonnet-5-thinking-high", classified: "denied", contentLen: 0, reasoningLen: 0 },
    ];
    assert.equal(pickChatTransport("claude-sonnet-5", matrix, opts), CHAT_TOOLS);
    assert.equal(pickChatTransport("claude-sonnet-5-thinking-high", matrix, opts), CHAT_TOOLS);
  });

  it("stays on Inference when every sand chat RPC for Claude is exhausted or denied", () => {
    const matrix = [
      { rpc: "/aiserver.v1.InferenceService/Stream", model: "claude-opus-5-thinking-high", classified: "resource_exhausted", contentLen: 0, reasoningLen: 0 },
      { rpc: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools", model: "claude-opus-5-thinking-high", classified: "resource_exhausted", contentLen: 0, reasoningLen: 0 },
      { rpc: "/agent.v1.AgentService/Run", model: "claude-opus-5-thinking-high", classified: "denied", contentLen: 0, reasoningLen: 0 },
    ];
    assert.equal(pickChatTransport("claude-opus-5", matrix, opts), INFERENCE);
  });

  it("keeps kimi on Inference when that row completed", () => {
    const matrix = [
      { rpc: "/aiserver.v1.InferenceService/Stream", model: "kimi-k3-max", classified: "ok", contentLen: 4, reasoningLen: 20 },
      { rpc: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools", model: "kimi-k3-max", classified: "resource_exhausted", contentLen: 0, reasoningLen: 0 },
      { rpc: "/agent.v1.AgentService/Run", model: "kimi-k3-max", classified: "denied", contentLen: 0, reasoningLen: 0 },
    ];
    assert.equal(pickChatTransport("kimi-k3", matrix, opts), INFERENCE);
    assert.equal(pickChatTransport("kimi-k3-max", matrix, opts), INFERENCE);
  });

  it("defaults to Inference when the matrix is empty", () => {
    assert.equal(pickChatTransport("claude-fable-5.1", [], opts), INFERENCE);
    assert.equal(pickChatTransport("claude-fable-5.1", null, opts), INFERENCE);
  });
});

describe("createRun dispatch", () => {
  const workingChat = [
    {
      rpc: "/aiserver.v1.InferenceService/Stream",
      model: "claude-sonnet-5-thinking-high",
      classified: "resource_exhausted",
      contentLen: 0,
      reasoningLen: 0,
    },
    {
      rpc: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
      model: "claude-sonnet-5-thinking-high",
      classified: "ok",
      contentLen: 4,
      reasoningLen: 0,
    },
  ];
  const exhausted = [
    {
      rpc: "/aiserver.v1.InferenceService/Stream",
      model: "claude-opus-5-thinking-high",
      classified: "resource_exhausted",
      contentLen: 0,
      reasoningLen: 0,
    },
    {
      rpc: "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
      model: "claude-opus-5-thinking-high",
      classified: "resource_exhausted",
      contentLen: 0,
      reasoningLen: 0,
    },
    {
      rpc: "/agent.v1.AgentService/Run",
      model: "claude-opus-5-thinking-high",
      classified: "denied",
      contentLen: 0,
      reasoningLen: 0,
    },
  ];

  it("leaves Inference for a ChatService factory when the matrix row works", () => {
    const factory = resolveSandRun("claude-sonnet-5", { matrix: workingChat });
    assert.equal(factory, createChatServiceRun);
    assert.equal(sandRpcPath(CHAT_TOOLS), CHAT_SERVICE_PATH);
    const body = buildChatServiceRequest({
      prompt: "Reply with exactly: pong",
      modelId: "claude-sonnet-5-thinking-high",
      conversationId: "t1",
    });
    assert.equal(body.streamUnifiedChatRequest.modelDetails.modelName, "claude-sonnet-5-thinking-high");
    assert.match(body.streamUnifiedChatRequest.conversation[0].text, /pong/);
  });

  it("stays on the Inference factory when every Claude chat RPC is exhausted", () => {
    const factory = resolveSandRun("claude-opus-5", { matrix: exhausted });
    assert.equal(factory, createInferenceRun);
    assert.equal(sandRpcPath(INFERENCE), INFERENCE_PATH);
  });

  it("honours an explicit chatTransport override onto the Agent factory", () => {
    const factory = resolveSandRun("kimi-k3", { chatTransport: AGENT });
    assert.equal(factory, createAgentRun);
    assert.equal(sandRpcPath(AGENT), AGENT_PATH);
  });
});

describe("sand status snapshot", () => {
  it("keeps fulfilled unary bodies and turns rejections into error objects", () => {
    assert.deepEqual(settledOrError({ status: "fulfilled", value: { usagePercent: 1.4 } }), {
      usagePercent: 1.4,
    });
    assert.equal(
      settledOrError({ status: "rejected", reason: new Error("timeout") }).error,
      "timeout"
    );
  });
});
