const config = require("./config");
const protocol = require("./openai-protocol");
const { newCompletionId } = require("./openai-sse");

function mapModel(model) {
  if (!model) return config.cursor.defaultModel;
  const mapped = config.modelMapping[model];
  if (mapped) return mapped;
  return model;
}

function buildChatResponse(text, model, inputTokens, outputTokens, extra = {}) {
  const usage = protocol.usageFrom({ inputTokens, outputTokens, ...extra.usageDetails });
  const fields = protocol.finalizeAssistantFields({
    text,
    thinking: extra.thinking,
    toolCalls: extra.toolCalls,
  });
  const message = { role: "assistant", content: fields.content };
  if (fields.reasoning_content) {
    message.reasoning_content = fields.reasoning_content;
    message.reasoning = fields.reasoning_content;
  }
  const parts = extra.reasoningParts || extra.usageDetails && extra.usageDetails.reasoningParts;
  if (Array.isArray(parts) && parts.length) {
    message.reasoning_parts = parts.map((p) => ({
      text: p.text || "",
      signature: p.signature || "",
      is_redacted: Boolean(p.isRedacted || p.is_redacted),
    }));
    const sigs = message.reasoning_parts.map((p) => p.signature).filter(Boolean);
    if (sigs.length === 1) message.reasoning_signature = sigs[0];
  } else if (extra.reasoningSignature) {
    message.reasoning_signature = extra.reasoningSignature;
  }
  if (fields.tool_calls) message.tool_calls = fields.tool_calls;
  const finish = extra.error
    ? "stop"
    : protocol.finishReasonFor(extra.usageDetails, Boolean(fields.tool_calls));
  const body = {
    id: extra.id || newCompletionId(),
    object: "chat.completion",
    created: extra.created || Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: extra.systemFingerprint || null,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: finish,
      },
    ],
    usage,
  };
  if (extra.conversationId) body.conversation_id = extra.conversationId;
  if (extra.ignoredParams?.length) body.cursor_ignored_params = extra.ignoredParams;
  // The trace carries every exec the turn saw, arguments included — kilobytes of
  // internal state, sometimes file paths and shell commands, on every response.
  if (config.debug.toolTrace && extra.toolTrace && extra.toolTrace.length) {
    body.tool_trace = extra.toolTrace;
  }
  return body;
}

// OpenAI types error.code as a string; an integer here breaks any consumer that
// deserialises into a typed error struct.
const ERROR_DEBUG_FIELDS = [
  ["detail", "detail"],
  ["hint", "hint"],
  ["cursorError", "cursor_error"],
  ["cursorTitle", "cursor_title"],
  ["cursorDetail", "cursor_detail"],
  ["actionRequired", "action_required"],
  ["retryable", "retryable"],
  ["model", "model"],
  ["requestedModel", "requested_model"],
  ["conversationId", "conversation_id"],
];

function buildErrorResponse(message, type = "api_error", code = "upstream_error", extra = {}) {
  const error = {
    message: String(message || "upstream error"),
    type,
    param: extra.param ?? null,
    code,
  };
  for (const [src, dst] of ERROR_DEBUG_FIELDS) {
    const v = extra[src];
    if (v == null || v === "") continue;
    if (dst === "detail" && v === error.message) continue;
    error[dst] = v;
  }
  return { error };
}

function publicErrorExtra(failure) {
  const { error } = buildErrorResponse(
    failure && failure.message,
    (failure && failure.type) || "api_error",
    (failure && failure.code) || "upstream_error",
    failure || {}
  );
  const extra = { ...error };
  delete extra.message;
  delete extra.type;
  delete extra.code;
  delete extra.param;
  return extra;
}

function buildModelsResponse(cursorModels = []) {
  const models = cursorModels.map((m) => ({
    id: m.modelId || m.model_id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "cursor",
    permission: [],
    root: m.modelId || m.model_id,
    parent: null,
  }));

  return { object: "list", data: models };
}

function buildModelObject(id, created) {
  return {
    id,
    object: "model",
    created: created || Math.floor(Date.now() / 1000),
    owned_by: "cursor",
    permission: [],
    root: id,
    parent: null,
  };
}

module.exports = {
  mapModel,
  buildChatResponse,
  buildErrorResponse,
  publicErrorExtra,
  buildModelsResponse,
  buildModelObject,
};
