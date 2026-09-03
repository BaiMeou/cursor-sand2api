const path = require("path");

function boolEnv(name, fallback) {
  const v = (process.env[name] || "").trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Cursor injects its own agent prompt plus a native tool registry no matter what
// the run request says. `x-cursor-agent-allowed-tools` is the only lever that
// narrows it; `mcp_tool_call` alone leaves the model with exactly the functions
// the OpenAI caller declared. `*` drops the header and restores stock behaviour.
function allowedNativeTools() {
  const raw = process.env.CURSOR_ALLOWED_NATIVE_TOOLS;
  if (raw === undefined || raw.trim() === "") return [];
  if (raw.trim() === "*") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  cursor: {
    baseUrl: process.env.CURSOR_BASE_URL || "https://api2.cursor.sh",
    clientVersion: process.env.CURSOR_CLIENT_VERSION || "3.17.21",
    clientType: process.env.CURSOR_CLIENT_TYPE || "sand",
    sandNamespace: process.env.SAND_BOX_NAMESPACE || "prod",
    defaultModel: process.env.DEFAULT_MODEL || "kimi-k3",
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT || "300000", 10),
    // No inbound frame at all for this long means the socket is dead. Cursor
    // heartbeats every few seconds, so silence here is a real stall.
    idleTimeout: parseInt(process.env.IDLE_TIMEOUT || "120000", 10),
    // Frames keep coming but none of them is model output: the turn is wedged
    // on a handshake the idle clock alone would never notice.
    outputTimeout: parseInt(process.env.OUTPUT_TIMEOUT || "240000", 10),
    heartbeatInterval: 5000,
    userAgent: process.env.CURSOR_USER_AGENT || "connect-es/1.6.1",
    acceptGzip: boolEnv("CURSOR_ACCEPT_GZIP", false),
    ghostMode: process.env.CURSOR_GHOST_MODE || "",
    allowedNativeTools: allowedNativeTools(),
    // Declare caller functions as MCP tools so the model gets real tool calls
    // instead of the invoke_client_tool text marker.
    declareMcpTools: boolEnv("DECLARE_MCP_TOOLS", false),
    // Send history as KV blobs the server pulls back, instead of flattening
    // every message into one user turn.
    conversationHistory: boolEnv("CONVERSATION_HISTORY", false),
    // Cursor discards a real system role; delivering it as an opening exchange
    // is the only form that survives. Turn off to send the role verbatim.
    systemAsHistory: boolEnv("SYSTEM_AS_HISTORY", true),
    continuationPrompt:
      process.env.CONTINUATION_PROMPT || "Continue, using the tool results above.",
    // Cursor runs the search itself; the client only grants permission. Off by
    // default because it spends the account's quota on someone else's query.
    webSearch: boolEnv("WEB_SEARCH", false),
  },

  tokens: {
    // Cooldown is off. 429 is shared Cursor usage, not a dead credential;
    // benching the JWT just hides a still-usable account.
    cooldownMs: parseInt(process.env.TOKEN_COOLDOWN_MS || "0", 10),
    authCooldownMs: parseInt(process.env.TOKEN_AUTH_COOLDOWN_MS || "0", 10),
    rateLimitCooldownMs: parseInt(process.env.TOKEN_RATE_LIMIT_COOLDOWN_MS || "0", 10),
    // Off by default. Preferring one plan label is an operator choice, not a
    // fair public default — it also hides plan mismatch from callers.
    preferGrokBotPlan: boolEnv("PREFER_GROK_BOT_PLAN", false),
  },

  debug: {
    toolTrace: boolEnv("DEBUG_TOOL_TRACE", false),
    prompt: boolEnv("DEBUG_PROMPT", false),
  },

  models: {
    cacheTtlMs: parseInt(process.env.MODEL_CACHE_TTL_MS || "900000", 10),
    errorCacheTtlMs: parseInt(process.env.MODEL_ERROR_CACHE_TTL_MS || "30000", 10),
    // Resolve caller model names against the account's own catalog and turn
    // reasoning_effort into a real parameter instead of a line of prose.
    useParameters: boolEnv("MODEL_PARAMETERS", false),
  },

  tools: {
    // client = OpenAI tool_calls (execute on caller)
    // workspace = proxy executes in WORKSPACE_DIR
    // none = reject tools
    mode: (process.env.TOOL_MODE || "client").toLowerCase(),
    workspaceDir: process.env.WORKSPACE_DIR || path.join(__dirname, "..", "workspace"),
    shell: process.env.ENABLE_SHELL === "1" || process.env.ENABLE_SHELL === "true",
    fetch: process.env.ENABLE_FETCH !== "0",
    shellTimeoutMs: parseInt(process.env.SHELL_TIMEOUT_MS || "30000", 10),
  },

  modelMapping: {
    "kimi-k3": "kimi-k3",
    "kimi-k3-low": "kimi-k3",
    "kimi-k3-high": "kimi-k3",
    "kimi-k3-max": "kimi-k3",
    "gpt-4": "composer-2",
    "gpt-4o": "composer-2",
    "gpt-4o-mini": "composer-2-fast",
    "composer-2": "composer-2",
    "composer-2-fast": "composer-2-fast",
    "composer-2.5": "composer-2.5",
    "composer-2.5-fast": "composer-2.5-fast",
    "claude-3.5-sonnet": "claude-4.5-sonnet",
    "claude-fable": "claude-fable-5-1",
    "claude-fable-5.1": "claude-fable-5-1",
    "claude-fable-5-1": "claude-fable-5-1",
    "claude-sonnet-4.5": "claude-4.5-sonnet",
    "claude-sonnet-4-5": "claude-4.5-sonnet",
    "claude-sonnet-4.6": "claude-4.6-sonnet",
    "claude-sonnet-4-6": "claude-4.6-sonnet",
    "claude-opus-4.5": "claude-4.5-opus",
    "claude-opus-4-5": "claude-4.5-opus",
    "claude-opus-4.6": "claude-4.6-opus",
    "claude-opus-4-6": "claude-4.6-opus",
    "claude-opus-4.7": "claude-opus-4-7",
    "claude-opus-4.8": "claude-opus-4-8",
    "claude-opus-5": "claude-opus-5",
    "claude-sonnet-5": "claude-sonnet-5",
    "grok-4.6": "grok-4.6",
    "cursor-grok-4.6-high": "grok-4.6",
    default: "kimi-k3",
  },
};

module.exports = config;
