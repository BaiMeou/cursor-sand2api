const express = require("express");
const cors = require("cors");
const path = require("path");
const cursorClient = require("./src/cursor-client");
const officialClient = require("./src/official-client");
const converter = require("./src/converter");
const config = require("./src/config");
const execHost = require("./src/exec-host");
const openaiMap = require("./src/openai-map");
const protocol = require("./src/openai-protocol");
const history = require("./src/history");
const { ChatStream, TextCompletionStream, flushAssistantStream } = require("./src/openai-sse");
const responses = require("./src/responses-protocol");
const { ResponseStream } = require("./src/responses-sse");
const { TokenPool, accountKey } = require("./src/token-pool");
const modelCatalog = require("./src/model-catalog");
const imageAttach = require("./src/image-attach");
const documentAttach = require("./src/document-attach");
const modelList = require("./src/model-list");
const { parseRequestedModel, prefixOfficialId, prefixOfficialUsable } = require("./src/model-route");
const modelFamily = require("./src/model-family");
const { createAccountModels } = require("./src/account-models");
const inferencePrompt = require("./src/inference-prompt");
const claudeTools = require("./src/claude-tools");
const { penalize: applyPenalty, sendHttpFailure: writeHttpFailure } = require("./src/penalize");
const { isGrokBotPlan, applyUsage } = require("./src/sand-plan");
const { resolveWebUi, requireApiKeyForBind, corsOriginOption } = require("./src/listen-guard");
const { publicHealth, stripUsagePii } = require("./src/health-view");

const sessions = new Map();
const toolCallIndex = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

function forgetSession(id) {
  const rec = sessions.get(id);
  if (!rec) return;
  if (rec.timer) clearTimeout(rec.timer);
  for (const cid of rec.callIds || []) toolCallIndex.delete(cid);
  sessions.delete(id);
}

function putSession(id, rec) {
  const prev = sessions.get(id);
  if (prev && prev !== rec && prev.timer) clearTimeout(prev.timer);
  rec.callIds = rec.callIds || [];
  rec.timer = setTimeout(() => {
    try {
      rec.run.abort();
    } catch {}
    forgetSession(id);
  }, SESSION_TTL_MS);
  sessions.set(id, rec);
}

function indexToolCalls(conversationId, rec, calls) {
  rec.callIds = rec.callIds || [];
  for (const c of calls || []) {
    if (!c.id) continue;
    toolCallIndex.set(c.id, conversationId);
    rec.callIds.push(c.id);
  }
  putSession(conversationId, rec);
}

function takeSession(id) {
  const rec = sessions.get(id);
  if (!rec) return null;
  putSession(id, rec);
  return rec;
}

function findLiveSession(messages, conversationId) {
  if (conversationId) {
    const rec = takeSession(conversationId);
    if (rec) return rec;
  }
  const trailing = openaiMap.extractTrailingToolResults(messages);
  for (const t of trailing) {
    const sid = t.tool_call_id && toolCallIndex.get(t.tool_call_id);
    if (sid) {
      const rec = takeSession(sid);
      if (rec) return rec;
    }
  }
  for (const cid of openaiMap.lastAssistantToolCallIds(messages)) {
    const sid = toolCallIndex.get(cid);
    if (sid) {
      const rec = takeSession(sid);
      if (rec) return rec;
    }
  }
  return null;
}

const VERSION = require("./package.json").version;
const PORT = parseInt(process.env.PORT || "13000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.API_KEY || "";
const TOKEN_FILE = process.env.TOKEN_FILE || path.join(__dirname, "token.json");
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || config.cursor.defaultModel;
// A full turn of attachments is 15 MB of images plus 20 MB of documents, and
// base64 adds a third on top, so the old 10 MB ceiling rejected uploads the
// attachment layer was built to accept.
const MAX_BODY_SIZE = process.env.MAX_BODY_SIZE || "64mb";
const WEB_UI = resolveWebUi(process.env.WEB_UI, HOST);

const pool = new TokenPool(TOKEN_FILE, {
  cooldownMs: config.tokens.cooldownMs,
  log: (msg) => console.log(msg),
});

const catalog = modelCatalog.createCatalog({
  ttlMs: config.models.cacheTtlMs,
  errorTtlMs: config.models.errorCacheTtlMs,
  fetchCatalog: async () => {
    const token = pool.next("sand");
    if (!token) throw new Error("no sand token for the model catalog");
    return cursorClient.getModelCatalog(token, modelCatalog.catalogRequestBody());
  },
});

// Never let a catalog problem take a chat request down with it: without it the
// model name goes upstream exactly as it does today.
async function resolveRequestedModel(requestedModel, body) {
  const parsed = parseRequestedModel(requestedModel);
  const usable = [...accountModels.union(parsed.official ? "api" : "sand")];
  let table = null;
  try {
    table = await catalog.get();
  } catch {}
  return modelFamily.resolvePublicRequest(requestedModel, body, {
    usable,
    catalog: table,
    mapModel: converter.mapModel,
  });
}

// Two upstream calls: the runnable names, and the metadata worth reporting
// alongside them. Either can fail on its own without emptying the list.
const models = modelList.createModelList({
  ttlMs: config.models.cacheTtlMs,
  errorTtlMs: config.models.errorCacheTtlMs,
  fetchUsable: async () => {
    const token = pool.next("sand");
    if (!token) throw new Error("no sand token for the model list");
    return cursorClient.getModels(token);
  },
  fetchCatalog: async () => {
    const token = pool.next("sand");
    if (!token) throw new Error("no sand token for the model catalog");
    return cursorClient.getModelCatalog(token, {});
  },
});

const accountModels = createAccountModels({
  ttlMs: config.models.cacheTtlMs,
  errorTtlMs: config.models.errorCacheTtlMs,
  persistPath: path.join(path.dirname(TOKEN_FILE), "token-disabled.json"),
  fetchSand: (token) => cursorClient.getModels(token),
  fetchOfficial: (token) => officialClient.getModels(token),
  verifyModels: ["kimi-k3"],
  verifyOfficial: async (account, modelId) => {
    const run = officialClient.createRun(account, "Reply with exactly: pong", modelId, { mode: "none" });
    const timed = new Promise((resolve) => {
      setTimeout(() => {
        try {
          run.abort();
        } catch {}
        resolve({ type: "error", error: "verify timeout" });
      }, 45000);
    });
    const ev = await Promise.race([run.wait(), timed]);
    if (ev && ev.type === "done") return { status: "ok" };
    const failure = protocol.classifyUpstreamError(ev && ev.error);
    return {
      status: failure.code === "model_quota_exhausted" ? "quota" : "error",
      detail: failure.detail || (ev && ev.error) || "",
    };
  },
  log: (msg) => console.log(msg),
});

async function publicModelList() {
  await accountModels.refresh(pool.accounts);
  const stamp = Math.floor(Date.now() / 1000);
  const sandMeta = await models.list().catch(() => ({ data: [] }));
  const metaById = new Map((sandMeta.data || []).map((m) => [m.id, m]));
  const sandUnion = [...accountModels.union("sand")];
  const sandData = [];
  const seen = new Set();
  for (const fam of modelFamily.collapseIds(sandUnion)) {
    if (!fam || fam === "default" || seen.has(fam.toLowerCase())) continue;
    seen.add(fam.toLowerCase());
    const members = modelFamily.membersOf(fam, sandUnion);
    let meta = metaById.get(fam);
    if (!meta) {
      for (const m of members) {
        if (metaById.has(m)) {
          meta = metaById.get(m);
          break;
        }
      }
    }
    const aliases = new Set(modelFamily.dottedAliases(fam));
    for (const m of members) if (m !== fam) aliases.add(m);
    if (meta && Array.isArray(meta.aliases)) {
      for (const a of meta.aliases) aliases.add(a);
    }
    aliases.delete(fam);
    sandData.push(
      modelList.buildModelObject(
        {
          id: fam,
          displayName: meta && meta.display_name,
          aliases: [...aliases],
          contextWindow: meta && meta.context_window,
          vendor: meta && meta.vendor,
          capabilities:
            meta && meta.supports_images !== undefined
              ? {
                  images: meta.supports_images,
                  thinking: meta.supports_thinking,
                  maxMode: meta.supports_max_mode,
                  agent: meta.supports_agent,
                }
              : null,
        },
        stamp
      )
    );
  }
  const apiPrefixed = prefixOfficialUsable({
    models: [...accountModels.union("api")].sort().map((id) => ({ name: id })),
  });
  const apiData = (apiPrefixed.models || []).map((m) =>
    modelList.buildModelObject({ id: m.name, displayName: m.displayName, aliases: m.aliases }, stamp)
  );
  return { object: "list", data: [...sandData, ...apiData] };
}

const app = express();
app.use(cors({ origin: corsOriginOption(process.env.CORS_ORIGIN, HOST) }));
app.use(express.json({ limit: MAX_BODY_SIZE }));

// The console is a plain static bundle that talks to this server's own OpenAI
// surface. It is served unauthenticated on purpose: the page itself holds no
// secret, and every call it makes still goes through checkApiKey.
if (WEB_UI) {
  app.use(express.static(path.join(__dirname, "public"), { index: "index.html", maxAge: "1h" }));
}

function checkApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!key) {
    return res.status(401).json({
      error: { message: "Missing Authorization header", type: "authentication_error", param: null, code: "invalid_api_key" },
    });
  }
  if (key !== API_KEY) {
    return res.status(401).json({
      error: { message: "Invalid API key", type: "authentication_error", param: null, code: "invalid_api_key" },
    });
  }
  next();
}

app.get("/v1/models", checkApiKey, async (req, res) => {
  try {
    res.json(await publicModelList());
  } catch (e) {
    console.log(`model list unavailable: ${e.message}`);
    res.json({ object: "list", data: [] });
  }
});

// 401/403 may still bench the credential. 429 does not: shared Cursor
// usage is not a dead JWT, and shouldFailover stays false so we do not
// bounce the other sand account on the same window.
function penalize(token, rawError, modelId, official) {
  return applyPenalty(pool, token, rawError, modelId, official, { protocol, accountModels, config });
}

function clientFor(token) {
  return token && token.kind === "api" ? officialClient : cursorClient;
}

function shouldFailover(failure) {
  return protocol.shouldFailover(failure);
}

function publicCalls(ev) {
  return (ev.tool_calls || []).map((c, i) => openaiMap.publicToolCall(c, i));
}

function openSse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function sendHttpFailure(res, failure) {
  return writeHttpFailure(res, failure, { config, converter });
}

function attachFailureContext(failure, ev, requestedModel) {
  if (!failure) return failure;
  if (ev && ev.accountName) failure.account = ev.accountName;
  if (ev && ev.accountKind) failure.accountKind = ev.accountKind;
  if (ev && ev.cursorModel) failure.model = ev.cursorModel;
  if (requestedModel) failure.requestedModel = requestedModel;
  if (ev && ev.conversationId) failure.conversationId = ev.conversationId;
  return failure;
}

// A dialect is only two things: the stream class that speaks its wire format,
// and the function that restates a finished chat body in its shape. Everything
// between the two is shared, so a new facade adds no branches to the request
// path. `toBody` absent means the chat body is already the answer.
const FACADES = {
  chat: { Stream: ChatStream },
  completions: {
    Stream: TextCompletionStream,
    toBody: (chat, model) => protocol.toTextCompletion(chat, model),
  },
  responses: {
    Stream: ResponseStream,
    toBody: (chat, model, ctx) => responses.toResponse(chat, model, ctx),
  },
};

function writeOpenAIEvent(res, requestedModel, ev, ignored, stream, facade = FACADES.chat) {
  const calls = ev.type === "tool_calls" ? publicCalls(ev) : ev.tool_calls;
  const fields = protocol.finalizeAssistantFields({
    text: ev.text,
    thinking: ev.thinking,
    toolCalls: calls,
  });
  const usage = protocol.usageFrom(ev);
  if (ev.conversationId && !res.headersSent) {
    try {
      res.setHeader("X-Conversation-Id", ev.conversationId);
    } catch {}
  }

  if (stream && stream.isStream) {
    if (ev.type === "error") {
      const failure = attachFailureContext(protocol.classifyUpstreamError(ev.error), ev, requestedModel);
      // Nothing has been written yet, so this can still be a real status code
      // the caller's gateway knows how to fail over on.
      if (!stream.opened()) return sendHttpFailure(res, failure);
      stream.open().error(failure.message, failure.type, failure.code, converter.publicErrorExtra(failure));
      return;
    }
    const out = stream.open();
    flushAssistantStream(out, fields);
    if (typeof out.reasoningSignature === "function" && (ev.reasoningParts || []).length) {
      const sigs = ev.reasoningParts.map((p) => p.signature).filter(Boolean);
      out.reasoningSignature(sigs.length === 1 ? sigs[0] : "", ev.reasoningParts);
    }
    out.finish(protocol.finishReasonFor(ev, Boolean(fields.tool_calls)), usage);
    return;
  }

  if (ev.type === "error") {
    return sendHttpFailure(res, attachFailureContext(protocol.classifyUpstreamError(ev.error), ev, requestedModel));
  }
  const chat = converter.buildChatResponse(ev.text, requestedModel, ev.inputTokens, ev.outputTokens, {
    thinking: ev.thinking,
    toolCalls: fields.tool_calls,
    conversationId: ev.conversationId,
    ignoredParams: ignored,
    toolTrace: ev.toolTrace,
    usageDetails: ev,
    reasoningParts: ev.reasoningParts,
  });
  if (!facade.toBody) return res.json(chat);
  return res.json(
    facade.toBody(chat, requestedModel, {
      usageDetails: ev,
      conversationId: ev.conversationId,
      ignoredParams: ignored,
      request: stream && stream.request,
    })
  );
}

// Prompt assembly is identical once a dialect has produced OpenAI-shaped
// messages and tools, so both facades share it.
function prepareTurn({ messages, tools, toolChoice, workspace, hintText, conversationId, signal, onDelta, onThinking, limits, images = [], documents = [], official = false, cursorModel = "" }) {
  const extra = openaiMap.customToolNames(tools);
  const allowedToolNames = openaiMap.requestToolNames(tools);
  const toolNames = openaiMap.toolNameMap(tools);
  const advertisedTools = toolChoice === "none" ? [] : tools;

  let prompt;
  let rootMessages;
  let inferenceUserText;
  let inferenceSystem;
  let mcpTools = [];

  if (official) {
    mcpTools =
      config.cursor.declareMcpTools && toolChoice !== "none"
        ? openaiMap.buildMcpToolDefinitions(tools, toolNames)
        : [];
    let promptPrefix =
      (hintText || "") +
      openaiMap.extraToolsPrompt(
        advertisedTools,
        workspace,
        mcpTools.length > 0,
        config.cursor.webSearch
      );
    if (toolChoice === "required") {
      promptPrefix +=
        "<tool_choice>You MUST call one of the CLIENT TOOLS before writing the user-visible answer. Do not answer with text only. Do not use Cursor built-in tools.</tool_choice>\n\n";
    } else if (toolChoice && toolChoice !== "auto" && toolChoice !== "none") {
      promptPrefix += `<tool_choice>You MUST call the CLIENT TOOL ${toolChoice} before answering. Do not use Cursor built-in tools.</tool_choice>\n\n`;
    }
    if (openaiMap.lastMessageIsTool(messages)) {
      promptPrefix +=
        "<openai_turn>The client already executed your tool calls. Use the tool_result blocks as ground truth and write a user-visible answer now. Do not call tools again unless you still need more data.</openai_turn>\n\n";
    }
    const turn = history.buildTurnInput(messages, {
      systemAsHistory: config.cursor.systemAsHistory,
      continuationPrompt: config.cursor.continuationPrompt,
      imagesAttached: images.length > 0,
      documentsAttached: documents.length > 0,
    });
    rootMessages = turn.rootMessages;
    inferenceUserText = turn.userText || config.cursor.continuationPrompt;
    inferenceSystem = promptPrefix;
    prompt = config.cursor.conversationHistory
      ? promptPrefix + inferenceUserText
      : openaiMap.messagesToPrompt(messages, promptPrefix, {
          imagesAttached: images.length > 0,
          documentsAttached: documents.length > 0,
        });
  } else {
    const infer = inferencePrompt.buildInferenceTurn({
      messages,
      imagesAttached: images.length > 0,
      documentsAttached: documents.length > 0,
    });
    rootMessages = infer.rootMessages;
    inferenceUserText = infer.userText;
    inferenceSystem = infer.systemText;
    prompt = infer.userText || "Hello";
    if (
      claudeTools.claudeNeedsTextTools(cursorModel) &&
      (advertisedTools.length || history.historyHasToolTurns(messages))
    ) {
      const prefix = advertisedTools.length ? openaiMap.textToolsPrompt(advertisedTools, toolChoice) : "";
      inferenceSystem = prefix + (inferenceSystem || "");
    }
  }

  if (config.debug.prompt) console.log(`--- prompt ---\n${prompt.slice(0, 1200)}\n--- end ---`);

  return {
    prompt,
    rootMessages,
    runOpts: {
      conversationId,
      workspace,
      mode: config.tools.mode,
      toolChoice,
      hasCustomTools: extra.length > 0,
      allowedToolNames,
      mcpTools,
      toolNames,
      rootMessages,
      inferenceUserText,
      inferenceSystem,
      webSearch: config.cursor.webSearch,
      signal,
      onDelta,
      onThinking,
      maxTokens: (limits && limits.maxTokens) || 0,
      stops: (limits && limits.stops) || [],
      images,
      documents,
      openaiTools: advertisedTools,
      temperature: (limits && limits.temperature),
      topP: (limits && limits.topP),
      xmlToolFormat:
        !official &&
        advertisedTools.length > 0 &&
        claudeTools.claudeTryCustomFormat(cursorModel),
      textToolsOnly:
        !official &&
        claudeTools.claudeNeedsTextTools(cursorModel) &&
        (advertisedTools.length > 0 || history.historyHasToolTurns(messages)),
      sourceMessages: messages,
    },
  };
}

// Resuming a parked stream versus starting a fresh Run is the subtlest logic
// here; both facades go through this one copy of it.
async function executeTurn({ token, prompt, cursorModel, requestedModel, runOpts, messages, conversationId, trailingTools }) {
  let ev;
  const live = trailingTools.length ? findLiveSession(messages, conversationId) : null;
  const liveOk =
    live &&
    (typeof live.run.alive !== "function" || live.run.alive()) &&
    live.run.submit(trailingTools) > 0;
  if (liveOk) {
    ev = await live.run.wait();
    if (ev.type === "tool_calls") {
      indexToolCalls(live.run.conversationId, live, ev.tool_calls);
    } else {
      forgetSession(live.run.conversationId);
    }
  } else {
    if (live) {
      try {
        live.run.abort();
      } catch {}
      forgetSession(live.run.conversationId);
    }
    const run = clientFor(token).createRun(token, prompt, cursorModel, {
      ...runOpts,
      conversationId: conversationId || undefined,
    });
    ev = await run.wait();
    if (ev.type === "tool_calls") {
      indexToolCalls(run.conversationId, { run, model: requestedModel }, ev.tool_calls);
    }
  }

  if (ev && typeof ev === "object") {
    ev.accountName = token.name;
    ev.accountKind = token.kind;
    ev.cursorModel = cursorModel;
    ev.requestedModel = requestedModel;
  }
  if (ev.type === "error") penalize(token, ev.error, cursorModel, token.kind === "api");
  else pool.markSuccess(token);
  return ev;
}

function logTurn(requestedModel, cursorModel, meta, ev, fields) {
  console.log(
    `${requestedModel} -> ${cursorModel} ${meta}`
  );
  console.log(
    `  finish=${ev.type} content=${(fields.content || "").length} reasoning=${(ev.thinking || "").length} tools=${(fields.tool_calls || []).length} promoted=${fields.promoted}`
  );
  if (ev.type === "error" && ev.error) {
    const failure = protocol.classifyUpstreamError(ev.error);
    console.log(
      `  error=${failure.cursorError || failure.code} http=${failure.status} action=${failure.actionRequired || "-"} retryable=${failure.retryable}`
    );
    console.log(`  detail=${String(failure.message || ev.error).replace(/\s+/g, " ").trim().slice(0, 300)}`);
  }
  const calls = fields.tool_calls || [];
  if (calls.length) {
    const preview = calls
      .map((c) => `${(c.function && c.function.name) || "?"}:${String((c.function && c.function.arguments) || "").slice(0, 80)}`)
      .join(" | ");
    console.log(`  calls=${preview}`);
  }
}

async function runCursorChat({ req, res, body, facade = FACADES.chat, sourceBody = null }) {
  const invalid = protocol.validateChatRequest(body);
  if (invalid) return res.status(400).json(invalid);

  const messages = protocol.normalizeMessages(body.messages);
  const tools = protocol.normalizeTools(body);
  const requestedModel = body.model || DEFAULT_MODEL;
  await accountModels.refresh(pool.accounts);
  const resolved = await resolveRequestedModel(requestedModel, sourceBody || body);
  if (resolved.error) return res.status(400).json(resolved.error);
  const cursorModel = resolved.modelId;
  const wantKind = resolved.official ? "api" : "sand";
  const tried = new Set();
  const pickToken = () => {
    const cover = (a) => accountModels.covers(a, cursorModel, resolved.official);
    const from = (filter) => {
      for (let i = 0; i < pool.accounts.length; i++) {
        const token = pool.next(wantKind, filter);
        if (!token) return null;
        const id = accountKey(token);
        if (!tried.has(id)) {
          tried.add(id);
          return token;
        }
      }
      return null;
    };
    if (config.tokens.preferGrokBotPlan) {
      return from((a) => cover(a) && isGrokBotPlan(a)) || from(cover);
    }
    return from(cover);
  };
  const covers = (a) => accountModels.covers(a, cursorModel, resolved.official);
  const hasKind = pool.accounts.some((a) => a.kind === wantKind);
  if (!hasKind) {
    const msg = resolved.official
      ? "No official Cursor API key (crsr_) in the pool — add a kind:api token"
      : "No sand Cursor JWT in the pool — run npm run token";
    return res.status(503).json(converter.buildErrorResponse(msg, "server_error", "pool_exhausted"));
  }
  if (!pool.accounts.some((a) => a.kind === wantKind && covers(a))) {
    return res.status(400).json(
      converter.buildErrorResponse(
        `model ${requestedModel} is not enabled for any ${wantKind} credential in the pool`,
        "invalid_request_error",
        "model_not_found"
      )
    );
  }
  let token = pickToken();
  if (!token) {
    return sendHttpFailure(res, protocol.classifyUpstreamError("POOL_EXHAUSTED"));
  }
  const isStream = body.stream === true;
  const includeUsage = Boolean(body.stream_options && body.stream_options.include_usage);
  const workspace =
    body.workspace || body.cwd || req.headers["x-workspace"] || req.headers["x-cursor-cwd"] || "";
  const conversationId =
    body.conversation_id || body.conversationId || req.headers["x-conversation-id"] || undefined;
  const ignored = openaiMap.ignoredOpenAIParams(body);
  const toolChoice = protocol.mapToolChoice(protocol.normalizeToolChoice(body));

  // Attachments belong to the turn being sent, so only the last user message
  // can carry them.
  const lastUser = openaiMap.lastUserIndex(messages);
  const activeContent = lastUser >= 0 ? messages[lastUser].content : null;
  const picked = activeContent ? imageAttach.collectImages(activeContent) : null;
  const files = activeContent ? documentAttach.collectDocuments(activeContent) : null;
  const attached = picked ? picked.attachments : [];
  const attachedDocs = files ? files.attachments : [];
  const notAttached = [...((picked && picked.skipped) || []), ...((files && files.skipped) || [])];
  if (notAttached.length) console.log(`  not attached: ${notAttached.join(" ")}`);

  const ac = new AbortController();
  req.on("aborted", () => ac.abort());

  // Headers are committed on the first thing worth sending. Flushing them up
  // front locks the response to 200, so an upstream refusal that arrives before
  // the first token could only ever be reported inside the stream.
  let streamObj = null;
  const stream = {
    isStream,
    // The dialect's own request body, for facades that echo it back.
    request: sourceBody || body,
    opened: () => Boolean(streamObj),
    open() {
      if (streamObj) return streamObj;
      openSse(res);
      streamObj = new facade.Stream(res, {
        model: requestedModel,
        includeUsage,
        request: sourceBody || body,
      });
      streamObj.role();
      return streamObj;
    },
  };

  const prepareArgs = {
    messages,
    tools,
    toolChoice,
    workspace,
    official: token.kind === "api",
    cursorModel,
    // Depth is carried by the model id itself when the catalog had a variant for
    // it, so the prose hint would only duplicate it.
    hintText: protocol.hintPrefix(body, { effortAsParameter: Boolean(resolved.effort) }),
    limits: protocol.outputLimits(body),
    images: attached,
    documents: attachedDocs,
    conversationId,
    signal: ac.signal,
    onDelta: isStream ? (text) => stream.open().content(text) : null,
    onThinking: isStream ? (text) => stream.open().reasoning(text) : null,
  };
  let { prompt, rootMessages, runOpts } = prepareTurn(prepareArgs);
  runOpts.effort = resolved.effort;

  try {
    const trailingTools = openaiMap.extractTrailingToolResults(messages);
    let ev = await executeTurn({
      token,
      prompt,
      cursorModel,
      requestedModel,
      runOpts,
      messages,
      conversationId,
      trailingTools,
    });
    while (ev.type === "error" && !stream.opened() && !trailingTools.length) {
      const failure = protocol.classifyUpstreamError(ev.error);
      if (!shouldFailover(failure)) break;
      const next = pickToken();
      if (!next) break;
      console.log(
        `failover ${token.name}/${token.kind} ${failure.status} -> ${next.name}/${next.kind}`
      );
      token = next;
      ev = await executeTurn({
        token,
        prompt,
        cursorModel,
        requestedModel,
        runOpts,
        messages,
        conversationId,
        trailingTools,
      });
    }

    const fields = protocol.finalizeAssistantFields({
      text: ev.text,
      thinking: ev.thinking,
      toolCalls: ev.type === "tool_calls" ? publicCalls(ev) : null,
    });
    logTurn(
      requestedModel,
      cursorModel,
      `stream=${isStream} kind=${token.kind} account=${token.name} mode=${config.tools.mode} tools=${tools.length} history=${rootMessages.length} effort=${resolved.effort || "-"} images=${attached.length} workspace=${workspace || "-"}`,
      ev,
      fields
    );

    return writeOpenAIEvent(res, requestedModel, ev, ignored, stream, facade);
  } catch (e) {
    const failure = attachFailureContext(penalize(token, e.message), {
      accountName: token && token.name,
      accountKind: token && token.kind,
      cursorModel,
    }, requestedModel);
    if (stream.opened()) {
      streamObj.error(failure.message, failure.type, failure.code, converter.publicErrorExtra(failure));
      return;
    }
    sendHttpFailure(res, failure);
  }
}

app.post("/v1/chat/completions", checkApiKey, async (req, res) => {
  return runCursorChat({ req, res, body: req.body || {} });
});

app.post("/v1/completions", checkApiKey, async (req, res) => {
  const source = req.body || {};
  return runCursorChat({
    req,
    res,
    body: protocol.completionsToChat(source),
    facade: FACADES.completions,
    sourceBody: source,
  });
});

app.post("/v1/responses", checkApiKey, async (req, res) => {
  const source = req.body || {};
  const invalid = responses.validateResponsesRequest(source);
  if (invalid) return res.status(invalid.error.code === "not_implemented" ? 501 : 400).json(invalid);
  return runCursorChat({
    req,
    res,
    body: responses.responsesToChat(source),
    facade: FACADES.responses,
    sourceBody: source,
  });
});

// Retrieval needs a store, and this proxy keeps no response bodies. Answering
// 501 is the honest version; fabricating one would tell a caller its `store`
// round-tripped when nothing was saved.
app.get("/v1/responses/:id", checkApiKey, (req, res) => {
  res.status(501).json(protocol.notImplemented("responses retrieval (nothing is stored)", "response_id"));
});

app.delete("/v1/responses/:id", checkApiKey, (req, res) => {
  res.status(501).json(protocol.notImplemented("responses deletion (nothing is stored)", "response_id"));
});

app.get("/v1/models/:id", checkApiKey, async (req, res) => {
  try {
    const list = await publicModelList();
    let found = modelList.findModel(req.params.id, list);
    const parsed = parseRequestedModel(req.params.id);
    const mapped = converter.mapModel(parsed.rest);
    if (!found && parsed.official && mapped) {
      found = modelList.findModel(prefixOfficialId(mapped), list);
    }
    if (!found && !parsed.official && mapped && mapped !== req.params.id) {
      found = modelList.findModel(mapped, list);
    }
    if (found) return res.json(found);
    return res.status(404).json(
      converter.buildErrorResponse(
        `model ${req.params.id} not found`,
        "invalid_request_error",
        "model_not_found"
      )
    );
  } catch {
    return res.status(502).json(
      converter.buildErrorResponse("model catalog unavailable", "api_error", "upstream_error")
    );
  }
});

function notImpl(path, name) {
  app.all(path, checkApiKey, (req, res) => {
    res.status(501).json(protocol.notImplemented(name));
  });
}
notImpl("/v1/embeddings", "embeddings");
notImpl("/v1/images/generations", "images.generations");
notImpl("/v1/images/edits", "images.edits");
notImpl("/v1/audio/speech", "audio.speech");
notImpl("/v1/audio/transcriptions", "audio.transcriptions");
notImpl("/v1/audio/translations", "audio.translations");
notImpl("/v1/moderations", "moderations");

function healthDetail() {
  return {
    ...publicHealth({ version: VERSION, tokens: pool.publicStatus() }),
    tokens: pool.status(),
    defaultModel: DEFAULT_MODEL,
    clientType: config.cursor.clientType,
    clientVersion: config.cursor.clientVersion,
    allowedNativeTools: config.cursor.allowedNativeTools,
    declareMcpTools: config.cursor.declareMcpTools,
    conversationHistory: config.cursor.conversationHistory,
    systemAsHistory: config.cursor.systemAsHistory,
    webSearch: config.cursor.webSearch,
    modelParameters: config.models.useParameters,
    preferGrokBotPlan: config.tokens.preferGrokBotPlan,
    idleTimeout: config.cursor.idleTimeout,
    outputTimeout: config.cursor.outputTimeout,
    tools: {
      mode: config.tools.mode,
      shell: config.tools.shell,
      fetch: config.tools.fetch,
      workspace: execHost.toolsEnabled() ? execHost.workspaceRoot() : null,
      openai_functions: openaiMap.BUILTIN_TOOLS.map((t) => t.function.name),
    },
    openai: protocol.openaiSurface(),
    allowlists: accountModels.status(),
    sandUsage: stripUsagePii(sandUsage),
    hardLimit,
    timeLeft,
  };
}

app.get("/health", (req, res) => {
  res.json(publicHealth({ version: VERSION, tokens: pool.publicStatus() }));
});

app.get("/health/detail", checkApiKey, (req, res) => {
  res.json(healthDetail());
});

let sandUsage = null;
let hardLimit = null;
let timeLeft = null;
async function refreshSandUsage() {
  try {
    const sands = pool.accounts.filter((a) => a.kind === "sand" && a.accessToken);
    const rows = await Promise.allSettled(sands.map((t) => cursorClient.getSandUsage(t)));
    for (let i = 0; i < sands.length; i++) {
      if (rows[i].status === "fulfilled") applyUsage(sands[i], rows[i].value);
    }
    const shown = sands.find((a) => isGrokBotPlan(a)) || sands[0] || pool.next("sand");
    if (!shown) return;
    const snap = await cursorClient.getSandStatus(shown);
    sandUsage = snap.usage;
    hardLimit = snap.hardLimit;
    timeLeft = snap.timeLeft;
  } catch (e) {
    sandUsage = { error: e.message };
  }
}

let count;
try {
  count = pool.load();
} catch (e) {
  console.error(`token file unusable (${TOKEN_FILE}): ${e.message}`);
  process.exit(1);
}
pool.watch();
if (execHost.toolsEnabled()) {
  execHost.ensureWorkspace();
}

const bindErr = requireApiKeyForBind(API_KEY, HOST);
if (bindErr) {
  console.error(bindErr);
  process.exit(1);
}
if (!API_KEY) {
  console.warn("API_KEY unset — requests are unauthenticated (localhost only)");
}

app.listen(PORT, HOST, () => {
  refreshSandUsage();
  setInterval(() => {
    refreshSandUsage().catch(() => {});
  }, 5 * 60 * 1000);
  console.log(`cursor-sand2api ${VERSION}  http://${HOST}:${PORT}`);
  console.log(
    `tokens=${count} default=${DEFAULT_MODEL} type=${config.cursor.clientType} mode=${config.tools.mode} native=${config.cursor.allowedNativeTools.join(",") || "*"} mcpTools=${config.cursor.declareMcpTools}`
  );
  if (execHost.toolsEnabled()) console.log(`workspace=${execHost.workspaceRoot()}`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
