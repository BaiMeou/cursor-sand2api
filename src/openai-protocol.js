const openaiMap = require("./openai-map");

const CHAT_PATH = "/v1/chat/completions";
const COMPLETIONS_PATH = "/v1/completions";
const RESPONSES_PATH = "/v1/responses";

function notImplemented(feature, param = null) {
  return {
    error: {
      message: `${feature} is not implemented: this is an unofficial OpenAI-compatible converter over Cursor credentials.`,
      type: "invalid_request_error",
      param,
      code: "not_implemented",
    },
  };
}

function normalizeTools(body) {
  if (Array.isArray(body.tools) && body.tools.length) return body.tools;
  if (Array.isArray(body.functions) && body.functions.length) {
    return body.functions.map((f) => ({ type: "function", function: f }));
  }
  return [];
}

function normalizeToolChoice(body) {
  if (body.tool_choice != null) return body.tool_choice;
  if (body.function_call == null) return undefined;
  if (body.function_call === "none" || body.function_call === "auto") return body.function_call;
  if (typeof body.function_call === "object") return { type: "function", function: body.function_call };
  if (typeof body.function_call === "string") return { type: "function", function: { name: body.function_call } };
  return undefined;
}

function mapToolChoice(toolChoice) {
  if (toolChoice === "none") return "none";
  if (toolChoice === "required") return "required";
  if (toolChoice && typeof toolChoice === "object") return toolChoice.function?.name || "auto";
  return "auto";
}

function hintPrefix(body, options = {}) {
  const lines = [];
  const rf = body.response_format;
  if (rf && rf.type === "json_object") {
    lines.push("Respond with a single JSON object only. No markdown fences.");
  } else if (rf && rf.type === "json_schema") {
    lines.push(`Respond with JSON matching this schema: ${JSON.stringify(rf.json_schema || rf.schema || {})}`);
  }
  // max_tokens and stop are enforced for real on the way out; the hint only
  // nudges the model so it can wrap up rather than being cut mid-sentence.
  const limits = outputLimits(body);
  if (limits.maxTokens) {
    lines.push(`Keep the visible answer under about ${limits.maxTokens} tokens; it is truncated past that.`);
  }
  if (limits.stops.length) {
    lines.push(`Stop before emitting: ${limits.stops.join(" | ")}`);
  }
  // Asking in prose is the fallback for models whose catalog entry publishes no
  // depth parameter; when one was sent, saying it twice only wastes tokens.
  if (body.reasoning_effort && !options.effortAsParameter) {
    lines.push(`Reasoning effort: ${body.reasoning_effort}.`);
  }
  if (!lines.length) return "";
  return `<openai_request>\n${lines.join("\n")}\n</openai_request>\n\n`;
}

function normalizeMessages(messages) {
  return (messages || []).map((m) => {
    const role = m.role === "developer" ? "system" : m.role;
    return { ...m, role };
  });
}

function completionsToChat(body) {
  const prompt = body.prompt;
  let text = "";
  if (typeof prompt === "string") text = prompt;
  else if (Array.isArray(prompt)) text = prompt.map(String).join("");
  else if (prompt != null) text = String(prompt);
  if (body.suffix) text += String(body.suffix);
  return {
    model: body.model,
    stream: body.stream === true,
    stream_options: body.stream_options,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    stop: body.stop,
    user: body.user,
    reasoning_effort: body.reasoning_effort,
    reasoning: body.reasoning,
    thinking: body.thinking,
    tools: body.tools,
    tool_choice: body.tool_choice,
    messages: [{ role: "user", content: text || " " }],
  };
}

function toTextCompletion(chatBody, requestedModel) {
  const msg = chatBody.choices && chatBody.choices[0] && chatBody.choices[0].message;
  const text = msg ? msg.content || "" : "";
  return {
    id: String(chatBody.id || "").replace(/^chatcmpl-/, "cmpl-"),
    object: "text_completion",
    created: chatBody.created,
    model: requestedModel,
    choices: [
      {
        text: text || "",
        index: 0,
        logprobs: null,
        finish_reason: chatBody.choices?.[0]?.finish_reason || "stop",
      },
    ],
    usage: chatBody.usage,
  };
}

function finalizeAssistantFields({ text, thinking, toolCalls }) {
  const thinkingStr = thinking && String(thinking).trim() ? String(thinking) : "";
  const content = text == null ? "" : String(text).trim();
  const calls = toolCalls && toolCalls.length ? toolCalls : null;
  return {
    content: calls && !content ? null : content,
    reasoning_content: thinkingStr || undefined,
    tool_calls: calls || undefined,
    promoted: false,
  };
}

// A capped answer must say so. Reporting "stop" tells the caller the model chose
// to end there, and it has no way to learn its own max_tokens was applied.
function finishReasonFor(ev, hasToolCalls) {
  if (ev && ev.cutReason === "length") return "length";
  return hasToolCalls ? "tool_calls" : "stop";
}

function outputLimits(body) {
  const source = body || {};
  const maxTokens = Number.parseInt(source.max_completion_tokens ?? source.max_tokens, 10);
  const raw = source.stop;
  const stops = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  const temperature = Number(source.temperature);
  const topP = Number(source.top_p);
  return {
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 0,
    stops: stops.filter((s) => typeof s === "string" && s),
    temperature: Number.isFinite(temperature) ? temperature : undefined,
    topP: Number.isFinite(topP) ? topP : undefined,
  };
}

function usageFrom(ev) {
  const source = ev || {};
  const prompt = source.inputTokens || 0;
  const completion = source.outputTokens || 0;
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  // Both live under prompt_tokens_details: a bare cache_creation_input_tokens at
  // the top level is an Anthropic field name that a relay summing usage keys
  // would double-count.
  if (source.cacheReadTokens || source.cacheWriteTokens) {
    usage.prompt_tokens_details = {};
    if (source.cacheReadTokens) usage.prompt_tokens_details.cached_tokens = source.cacheReadTokens;
    if (source.cacheWriteTokens) {
      usage.prompt_tokens_details.cache_creation_tokens = source.cacheWriteTokens;
    }
  }
  if (source.reasoningTokens) {
    usage.completion_tokens_details = { reasoning_tokens: source.reasoningTokens };
  }
  return usage;
}

// A gateway can only fail over on a status code it recognises. Collapsing every
// upstream failure into 500 means a rate limit, a dead token and a bad model all
// look the same, so nothing rotates and nothing retries.
const ERROR_COPY = {
  content_filter: "Request blocked by the model provider's content policy.",
  rate_limit_exceeded: "Cursor usage or rate limit reached. Retry shortly, switch model, or use the other pool (api-* vs unprefixed sand ids).",
  model_quota_exhausted: "This model has no remaining Cursor API quota on that credential. It is disabled until the quota resets.",
  invalid_api_key: "Cursor rejected the credential. For sand models re-import the IDE token; for api-* check the crsr_ key.",
  model_not_found: "This model is not available on the selected Cursor pool.",
  model_blocked: "This model is blocked for the account. Enable it and accept its data policy in the Cursor dashboard.",
  unsupported_region: "This model provider is not available in the Cursor account or converter region. Switch model, or send the request from an allowed region.",
  pro_rate_limit: "This Cursor plan hit a per-model rate limit. Wait, upgrade the plan, or use another account.",
  plan_restricted: "This Cursor plan cannot run that named model. Switch to Auto, or upgrade the Cursor membership.",
  pool_exhausted: "No available credential in the pool for this model. Re-import a token, wait for cooldown, or try another model.",
  permission_denied: "This Cursor account is not allowed to run that request.",
  context_length_exceeded: "The prompt exceeds the model's context window.",
  output_token_limit: "The model hit its output token limit before finishing.",
  overloaded: "The model provider is overloaded. Retry shortly.",
  client_closed_request: "The client aborted the request.",
};

const INFERENCE_ERROR_TYPES = {
  0: "unspecified",
  1: "unknown",
  2: "input_token_limit",
  3: "output_token_limit",
  4: "rate_limit",
  5: "authentication",
  6: "permission",
  7: "overloaded",
  8: "content_filter",
  UNSPECIFIED: "unspecified",
  UNKNOWN: "unknown",
  INPUT_TOKEN_LIMIT: "input_token_limit",
  OUTPUT_TOKEN_LIMIT: "output_token_limit",
  RATE_LIMIT: "rate_limit",
  AUTHENTICATION: "authentication",
  PERMISSION: "permission",
  OVERLOADED: "overloaded",
  CONTENT_FILTER: "content_filter",
};

function inferenceErrorTypeName(type) {
  if (type == null || type === "") return "";
  if (INFERENCE_ERROR_TYPES[type]) return INFERENCE_ERROR_TYPES[type];
  const s = String(type);
  const stripped = s.replace(/^INFERENCE_STREAM_ERROR_TYPE_/i, "").toUpperCase();
  return INFERENCE_ERROR_TYPES[stripped] || s.toLowerCase();
}

function tidyError(raw) {
  return String(raw || "upstream error")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function redactMoney(s) {
  return String(s).replace(/\$[\d,]+(?:\.\d+)?/g, "$…");
}

function extractCursorDebug(raw) {
  const out = { cursorError: "", title: "", detail: "", actionRequired: "", retryable: null };
  if (raw && typeof raw === "object") {
    const debug = raw.details && raw.details[0] && raw.details[0].debug;
    if (debug) {
      out.cursorError = String(debug.error || "");
      const d = debug.details || {};
      out.title = String(d.title || "");
      out.detail = String(d.detail || "");
      out.actionRequired = String((d.analyticsMetadata && d.analyticsMetadata.actionRequired) || "");
      if (typeof d.isRetryable === "boolean") out.retryable = d.isRetryable;
    }
  } else {
    const m = String(raw || "").match(/ERROR_[A-Z0-9_]+/);
    if (m) out.cursorError = m[0];
  }
  return out;
}

function displayUpstreamMessage(raw, code, extracted) {
  const ext = extracted || extractCursorDebug(raw);
  if (ext.cursorError && ext.detail) return redactMoney(`${ext.cursorError}: ${ext.detail}`);
  if (ext.detail) return redactMoney(ext.detail);
  if (ext.title && ext.cursorError) return redactMoney(`${ext.cursorError}: ${ext.title}`);
  const text = redactMoney(tidyError(typeof raw === "string" ? raw : ext.title || ext.cursorError));
  if (text && text !== "Error" && !/^resource_exhausted:\s*Error$/i.test(text) && text !== "upstream error") {
    return text;
  }
  return ERROR_COPY[code] || `Cursor upstream error: ${text || code}`;
}

function classified(status, type, code, raw, extracted) {
  const ext = extracted || extractCursorDebug(raw);
  const message = displayUpstreamMessage(raw, code, ext);
  const detail = redactMoney(tidyError(typeof raw === "string" ? raw : message));
  return {
    status,
    type,
    code,
    message,
    detail,
    hint: ERROR_COPY[code] || "",
    cursorError: ext.cursorError || "",
    cursorTitle: ext.title || "",
    cursorDetail: ext.detail || "",
    actionRequired: ext.actionRequired || "",
    retryable: ext.retryable,
  };
}

function classifyUpstreamError(raw) {
  const extracted = extractCursorDebug(raw);
  const into = (status, type, code) => classified(status, type, code, raw, extracted);
  let message;
  if (raw && typeof raw === "object") {
    const named = inferenceErrorTypeName(raw.errorType ?? raw.error_type);
    const flags = [];
    if (raw.isInputTokenLimitError || raw.is_input_token_limit_error) flags.push("input_token_limit");
    if (raw.isOutputTokenLimitError || raw.is_output_token_limit_error) flags.push("output_token_limit");
    message = [
      named,
      raw.code,
      flags.join(" "),
      raw.message,
      raw.error,
      extracted.cursorError,
      extracted.title,
      extracted.detail,
    ]
      .filter(Boolean)
      .join(" ");
    if (!message) message = JSON.stringify(raw);
  } else {
    message = String(raw || "upstream error");
  }
  const has = (...needles) => needles.some((n) => message.toLowerCase().includes(n.toLowerCase()));

  if (has("POOL_EXHAUSTED")) {
    return into(503, "server_error", "pool_exhausted");
  }

  // Cursor prefixes some provider refusals with `unauthenticated:`. That is
  // not a dead JWT — treating it as 401 used to bench the only healthy
  // account for 15 minutes.
  if (has("based on the content", "content policy", "content_filter", "refused to serve this request based on the content")) {
    return into(400, "invalid_request_error", "content_filter");
  }
  // Connect wraps Anthropic geo blocks as resource_exhausted / message "Error".
  // Classify the debug name first; a gateway that retries 429s would otherwise storm Claude.
  if (has("ERROR_UNSUPPORTED_REGION", "not supported in your region", "UNSUPPORTED_REGION")) {
    return into(403, "permission_error", "unsupported_region");
  }
  if (has("ERROR_PRO_USER_RATE_LIMIT_EXCEEDED", "PRO_USER_RATE_LIMIT")) {
    return into(429, "rate_limit_error", "pro_rate_limit");
  }
  if (has("ERROR_RATE_LIMITED_CHANGEABLE", "Free plans can only use Auto", "Upgrade to a paid plan", "set a Spend Limit")) {
    return into(403, "permission_error", "plan_restricted");
  }
  if (has("hit your usage limit", "API model usage", "Switch to a different model", "usage limits will reset", "Other Models usage limit")) {
    return into(429, "rate_limit_error", "model_quota_exhausted");
  }
  if (has("RATE_LIMIT", "resource_exhausted", "too many requests", "RateLimitError", "free-usage-exhausted", "Spend Limit")) {
    return into(429, "rate_limit_error", "rate_limit_exceeded");
  }
  if (has("AuthenticationError", "NOT_LOGGED_IN", "invalid api key", "invalid token", "HTTP 401", "Unauthorized")) {
    return into(401, "authentication_error", "invalid_api_key");
  }
  if (has("unauthenticated")) {
    return into(401, "authentication_error", "invalid_api_key");
  }
  if (has("MODEL_BLOCKED")) {
    return into(403, "permission_error", "model_blocked");
  }
  if (has("ERROR_BAD_MODEL_NAME", "MODEL_NOT_AVAILABLE", "MODEL_NOT_SUPPORTED", "Model name is not valid")) {
    return into(400, "invalid_request_error", "model_not_found");
  }
  if (has("input_token_limit", "INPUT_TOKEN_LIMIT", "context length", "context_length", "too many tokens", "maximum context")) {
    return into(400, "invalid_request_error", "context_length_exceeded");
  }
  if (has("output_token_limit", "OUTPUT_TOKEN_LIMIT")) {
    return into(400, "invalid_request_error", "output_token_limit");
  }
  if (has("overloaded")) {
    return into(503, "api_error", "overloaded");
  }
  if (has("permission_denied", "not allowed", "HTTP 403") || /\bpermission\b/i.test(message)) {
    return into(403, "permission_error", "permission_denied");
  }
  if (has("aborted")) {
    return into(499, "api_error", "client_closed_request");
  }
  if (has("invalid_argument", "invalid argument", "INVALID_ARGUMENT")) {
    return into(400, "invalid_request_error", "invalid_request");
  }
  return into(502, "api_error", "upstream_error");
}

// 429 is shared Cursor usage, not a dead credential. Failover just burns the
// other sand JWT and, behind a high gateway retry count, turns one miss into a storm.
function shouldFailover(failure) {
  if (!failure) return false;
  if (failure.status === 499) return false;
  if (failure.status === 429) return false;
  if (failure.code === "content_filter") return false;
  if (failure.code === "unsupported_region") return false;
  if (failure.code === "pool_exhausted") return false;
  if (failure.code === "plan_restricted") return true;
  return true;
}

function validateChatRequest(body) {
  if (!body || typeof body !== "object") {
    return { error: { message: "request body is required", type: "invalid_request_error", param: null, code: 400 } };
  }
  if (body.n && body.n !== 1) {
    return { error: { message: "n > 1 is not supported", type: "invalid_request_error", param: "n", code: "unsupported_parameter" } };
  }
  if (
    body.modalities &&
    Array.isArray(body.modalities) &&
    body.modalities.some((m) => m !== "text" && m !== "image")
  ) {
    return notImplemented("audio modalities", "modalities");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { error: { message: "messages is required", type: "invalid_request_error", param: "messages", code: 400 } };
  }
  return null;
}

function openaiSurface() {
  return {
    implemented: [
      "POST /v1/chat/completions",
      "POST /v1/completions",
      "POST /v1/responses (stateless subset: input items, streaming, tools)",
      "GET /v1/models",
      "GET /v1/models/{id}",
      "messages.role system/user/assistant/tool/function/developer",
      "messages.content string | array(text/input_text/output_text)",
      "image_url / input_image / input_file as Inference parts (data: URLs, history included)",
      "messages[].refusal",
      "tools + tool_choice + parallel tool_calls",
      "legacy functions / function_call",
      "stream + stream_options.include_usage (usage also rides the finish chunk)",
      "max_tokens / max_completion_tokens and stop, enforced, with finish_reason=length",
      "temperature / top_p on Inference model_config",
      "response_format json_object/json_schema (prompt-enforced)",
      "usage.prompt_tokens_details + completion_tokens_details",
      "reasoning_content (non-standard, widely used)",
      "multi-round role=tool + tool_call_id",
      "errors as a real status code, or an in-stream error frame once committed",
    ],
    not_implemented: [
      "embeddings",
      "images",
      "audio speech/transcriptions",
      "moderations",
      "files / fine-tuning / batches",
      "assistants",
      "responses store / retrieval / deletion / background (nothing is persisted)",
      "responses hosted tools (web_search, file_search, computer_use, code_interpreter)",
      "logprobs / logit_bias / seed sampling",
      "n>1",
      "images by remote URL (only data: URLs are uploaded)",
      "audio modalities",
    ],
  };
}

module.exports = {
  CHAT_PATH,
  COMPLETIONS_PATH,
  RESPONSES_PATH,
  notImplemented,
  normalizeTools,
  normalizeToolChoice,
  mapToolChoice,
  hintPrefix,
  normalizeMessages,
  completionsToChat,
  toTextCompletion,
  finalizeAssistantFields,
  usageFrom,
  finishReasonFor,
  outputLimits,
  classifyUpstreamError,
  extractCursorDebug,
  shouldFailover,
  inferenceErrorTypeName,
  validateChatRequest,
  openaiSurface,
  ignoredOpenAIParams: openaiMap.ignoredOpenAIParams,
};
