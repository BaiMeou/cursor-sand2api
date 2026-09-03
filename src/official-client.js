const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { createEventQueue } = require("./event-queue");
const { officialSelection } = require("./model-route");

const AMBIENT_DISALLOWED = ["shell", "read", "edit", "task", "webSearch", "webFetch"];
const TOOL_FLUSH_MS = 80;

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) sdkPromise = import("@cursor/sdk");
  return sdkPromise;
}

function officialWorkspace() {
  const dir = path.join(__dirname, "..", "workspace-official");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function asText(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return "";
}

function stringifyResult(content) {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content ?? "");
  } catch {
    return String(content ?? "");
  }
}

function buildCustomTools(openaiTools, onCall) {
  const out = {};
  for (const t of openaiTools || []) {
    const fn = t && t.function;
    if (!fn || !fn.name) continue;
    const name = fn.name;
    out[name] = {
      description: fn.description || `call client tool ${name}`,
      inputSchema:
        fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : { type: "object", properties: {} },
      execute: (args) => onCall(name, args && typeof args === "object" ? args : {}),
    };
  }
  return out;
}

function createRun(token, prompt, modelId, options = {}) {
  const conversationId = options.conversationId || uuidv4();
  const events = createEventQueue();
  const pending = new Map();
  const queued = [];
  let flushTimer = null;
  let done = false;
  let finishing = false;
  let errorMsg = "";
  let fullText = "";
  let thinkingText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let agent = null;
  let run = null;

  function emit(ev) {
    events.emit(ev);
  }

  function usageSnapshot() {
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens };
  }

  function ingestUsage(u) {
    if (!u || typeof u !== "object") return;
    if (typeof u.inputTokens === "number") inputTokens = u.inputTokens;
    if (typeof u.outputTokens === "number") outputTokens = u.outputTokens;
    if (typeof u.cacheReadTokens === "number") cacheReadTokens = u.cacheReadTokens;
    if (typeof u.cacheWriteTokens === "number") cacheWriteTokens = u.cacheWriteTokens;
    if (typeof u.reasoningTokens === "number") reasoningTokens = u.reasoningTokens;
  }

  function finish(kind) {
    if (finishing) return;
    finishing = true;
    done = true;
    clearTimeout(flushTimer);
    for (const [, p] of pending) {
      try {
        p.reject(new Error(errorMsg || "run ended"));
      } catch {}
    }
    pending.clear();
    emit({
      type: errorMsg ? "error" : kind || "done",
      text: fullText,
      thinking: thinkingText,
      conversationId,
      error: errorMsg ? String(errorMsg) : null,
      ...usageSnapshot(),
    });
    try {
      if (agent && typeof agent.close === "function") agent.close();
    } catch {}
  }

  function flushTools() {
    flushTimer = null;
    if (!queued.length || finishing) return;
    const batch = queued.splice(0);
    emit({
      type: "tool_calls",
      tool_calls: batch.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args || {}) },
        _kind: "official",
      })),
      conversationId,
      text: fullText,
      thinking: thinkingText,
      ...usageSnapshot(),
    });
  }

  function parkTool(name, args) {
    return new Promise((resolve, reject) => {
      const id = `call_${uuidv4().replace(/-/g, "").slice(0, 24)}`;
      pending.set(id, { resolve, reject, name });
      queued.push({ id, name, args });
      clearTimeout(flushTimer);
      flushTimer = setTimeout(flushTools, TOOL_FLUSH_MS);
    });
  }

  const openaiTools = options.toolChoice === "none" ? [] : options.openaiTools || [];
  const customTools = buildCustomTools(openaiTools, parkTool);
  const hasTools = Object.keys(customTools).length > 0;

  (async () => {
    try {
      const sdk = await loadSdk();
      const selection = officialSelection(modelId, options.effort);
      const cwd =
        options.workspace && typeof options.workspace === "string" && options.workspace.trim()
          ? options.workspace.trim()
          : officialWorkspace();
      agent = await sdk.Agent.create({
        apiKey: token.apiKey,
        model: selection,
        tools: hasTools ? ["mcp"] : [],
        disallowedTools: AMBIENT_DISALLOWED,
        local: {
          cwd,
          settingSources: [],
          ...(hasTools ? { customTools } : {}),
        },
      });
      run = await agent.send(prompt, {
        local: hasTools ? { customTools } : undefined,
        onDelta: async ({ update }) => {
          if (!update || finishing) return;
          if (update.type === "text-delta") {
            const t = asText(update.text);
            if (t) {
              fullText += t;
              if (options.onDelta) options.onDelta(t);
            }
          } else if (update.type === "thinking-delta") {
            const t = asText(update.text);
            if (t) {
              thinkingText += t;
              if (options.onThinking) options.onThinking(t);
            }
          } else if (update.type === "turn-ended") {
            ingestUsage(update.usage);
          }
          ingestUsage(update.usage);
        },
      });
      const result = await run.wait();
      ingestUsage(result && result.usage);
      if (result && result.status && result.status !== "finished") {
        errorMsg =
          (result.error && (result.error.message || result.error.code)) || `run ${result.status}`;
        finish("error");
        return;
      }
      if (!fullText && result && result.result) fullText = String(result.result);
      finish("done");
    } catch (e) {
      errorMsg = (e && (e.message || e.code)) || String(e);
      finish("error");
    }
  })();

  return {
    conversationId,
    wait: () => events.next(),
    alive: () => !done && !finishing,
    submit(results) {
      if (done || finishing) return 0;
      let n = 0;
      for (const res of results || []) {
        const p = pending.get(res.tool_call_id);
        if (!p) continue;
        n += 1;
        pending.delete(res.tool_call_id);
        p.resolve(stringifyResult(res.content));
      }
      if (n > 0) {
        // The next assistant turn must not replay the text from before the tools.
        fullText = "";
        thinkingText = "";
      }
      return n;
    },
    abort() {
      errorMsg = "Request aborted";
      try {
        if (run && typeof run.cancel === "function") run.cancel();
      } catch {}
      finish("error");
    },
  };
}

async function getModels(token) {
  const res = await fetch("https://api.cursor.com/v1/models", {
    headers: { Authorization: `Bearer ${token.apiKey}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body.message || body.error || `official models HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  const items = body.items || body.data || [];
  return {
    models: items.map((m) => ({
      name: m.id,
      displayName: m.displayName || m.id,
      aliases: m.aliases || [],
    })),
  };
}

async function getModelCatalog(token) {
  return getModels(token);
}

async function probe(token) {
  const res = await fetch("https://api.cursor.com/v1/me", {
    headers: { Authorization: `Bearer ${token.apiKey}` },
  });
  if (!res.ok) throw new Error(`official /v1/me HTTP ${res.status}`);
  return res.json();
}

module.exports = {
  createRun,
  getModels,
  getModelCatalog,
  probe,
  officialWorkspace,
  loadSdk,
};
