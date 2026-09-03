// Sand chat RPCs are interchangeable behind the OpenAI facade. The live matrix
// decides which one actually completes a family; the default remains Inference
// Service/Stream, the only path that has returned tokens with sand JWTs.
//
// 2026-09-02 Cursor 3.x workbench inventory: 87 services / 853 RPCs.
// StreamGenerate / StreamEdit / StreamChat / StreamUnifiedChat accept sand
// but only emit "upgrade Cursor" nags — not model tokens. AgentService/Run
// is sand_denied. ChatService/StreamUnifiedChatWithTools accepts sand and
// 429s (resource_exhausted) rather than denying the client type.

const INFERENCE = "inference";
const AGENT = "agent";
const CHAT_TOOLS = "chat-tools";

const INFERENCE_PATH = "/aiserver.v1.InferenceService/Stream";
const CHAT_SERVICE_PATH = "/aiserver.v1.ChatService/StreamUnifiedChatWithTools";
const AGENT_PATH = "/agent.v1.AgentService/Run";

function sandRpcPath(kind) {
  if (kind === CHAT_TOOLS) return CHAT_SERVICE_PATH;
  if (kind === AGENT) return AGENT_PATH;
  return INFERENCE_PATH;
}

function buildChatServiceRequest({ prompt, modelId, conversationId, userText } = {}) {
  const text = userText || prompt || "Hello";
  return {
    streamUnifiedChatRequest: {
      conversation: [{ text, type: 1 }],
      modelDetails: { modelName: modelId, maxMode: true },
      requestedModel: { modelId },
      conversationId,
      isChat: true,
      isAgentic: false,
      unifiedMode: 1,
      chatMode: "chat",
    },
  };
}

function rpcKind(rpc) {
  const s = String(rpc || "");
  if (s.includes("InferenceService")) return INFERENCE;
  if (s.includes("ChatService")) return CHAT_TOOLS;
  if (s.includes("AgentService")) return AGENT;
  return s;
}

function rowWorks(row) {
  if (!row) return false;
  if (row.classified && row.classified !== "ok") return false;
  return Number(row.contentLen || 0) > 0 || Number(row.reasoningLen || 0) > 0;
}

function familyOf(modelId, familyIdFn) {
  if (typeof familyIdFn === "function") return familyIdFn(modelId);
  return String(modelId || "");
}

function pickChatTransport(modelId, matrix, options = {}) {
  const familyId = options.familyId || ((id) => String(id || ""));
  const want = familyOf(modelId, familyId).toLowerCase();
  const rows = (matrix || []).filter((r) => familyOf(r.model, familyId).toLowerCase() === want);
  const order = [INFERENCE, CHAT_TOOLS, AGENT];
  for (const kind of order) {
    const hit = rows.find((r) => rpcKind(r.rpc) === kind && rowWorks(r));
    if (hit) return kind;
  }
  return INFERENCE;
}

module.exports = {
  INFERENCE,
  AGENT,
  CHAT_TOOLS,
  INFERENCE_PATH,
  CHAT_SERVICE_PATH,
  AGENT_PATH,
  rpcKind,
  rowWorks,
  pickChatTransport,
  sandRpcPath,
  buildChatServiceRequest,
};
