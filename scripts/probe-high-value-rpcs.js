#!/usr/bin/env node
// Curated sand probe: chat/inference/usage/catalog only. Skip admin/team/revoke.
const http2 = require("http2");
const fs = require("fs");
const path = require("path");
const { encodeFrame, createFrameReader } = require("../src/connect-frame");
const { generateChecksum, partText } = require("../src/cursor-client");

function loadToken() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
  const list = Array.isArray(data) ? data : data.tokens || [];
  const sand = list.filter((x) => x && x.accessToken && x.kind !== "api");
  return sand[0];
}

function clip(s, n = 180) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function classify(err, http, body) {
  const m = `${err || ""} ${body || ""}`.toLowerCase();
  if (m.includes("sand traffic is not supported")) return "sand_denied";
  if (m.includes("resource_exhausted") || m.includes("rate_limit")) return "resource_exhausted";
  if (m.includes("unimplemented") || m.includes("outdated version")) return "unimplemented";
  if (m.includes("unauthenticated") || m.includes("not_logged") || m.includes("invalid internal")) return "unauthenticated";
  if (m.includes("permission_denied") || m.includes("forbidden")) return "denied";
  if (m.includes("not_found") || http === 404) return "not_found";
  if (m.includes("invalid_argument") || m.includes("bad_request") || http === 400) return "exists_needs_body";
  if (m.includes("unsupported media") || http === 415) return "needs_proto";
  if (m.includes("timeout")) return "timeout";
  if (!err && http === 200) return "ok";
  if (http && http !== 200) return `http_${http}`;
  return "other";
}

function headers(token, rpcPath, contentType) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    ":method": "POST",
    ":path": rpcPath,
    "content-type": contentType,
    "connect-protocol-version": "1",
    authorization: `Bearer ${token.accessToken}`,
    "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
    "x-cursor-client-version": "3.17.21",
    "x-cursor-client-type": "sand",
    "x-sand-box-namespace": "prod",
    "x-cursor-timezone": "UTC",
    "x-request-id": requestId,
    "user-agent": "connect-es/1.6.1",
  };
}

function call(token, rpcPath, { contentType, body, stream, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const client = http2.connect("https://api2.cursor.sh");
    client.on("error", (e) =>
      resolve({ rpc: rpcPath, http: 0, classified: "conn", error: e.message, ms: Date.now() - started })
    );
    const ct = contentType || (stream ? "application/connect+json" : "application/json");
    const req = client.request(headers(token, rpcPath, ct));
    req.setTimeout(timeoutMs || (stream ? 12000 : 8000));
    const push = createFrameReader();
    let status = 0;
    let text = "";
    let thinking = "";
    let err = "";
    let raw = "";
    const finish = () => {
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      resolve({
        rpc: rpcPath,
        mode: stream ? "stream" : "unary",
        contentType: ct,
        http: status,
        classified: classify(err, status, raw || text),
        contentLen: text.length,
        reasoningLen: thinking.length,
        preview: clip(text || thinking || raw || err, 160),
        ms: Date.now() - started,
      });
    };
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (c) => {
      if (!stream) {
        raw += c.toString();
        return;
      }
      for (const frame of push(c)) {
        if (frame.kind === "trailer") {
          if (frame.error) err = frame.error;
          continue;
        }
        const msg = frame.message || {};
        if (msg.error) err = JSON.stringify(msg.error);
        const part = msg.textPart || msg.text_part;
        if (part) text += partText(part);
        const think = msg.thinkingPart || msg.thinking_part;
        if (think) thinking += partText(think);
        if (typeof msg.text === "string") text += msg.text;
        const inner = msg.streamUnifiedChatResponse || msg.streamUnifiedChatResponseWithTools || msg;
        if (inner && typeof inner.text === "string") text += inner.text;
        if (msg.completion) text += String(msg.completion);
      }
    });
    req.on("end", () => {
      if (!stream) {
        text = raw;
        err = "";
      }
      finish();
    });
    req.on("error", (e) => { err = e.message; finish(); });
    req.on("timeout", () => { err = err || "timeout"; finish(); });
    if (stream) {
      req.write(encodeFrame(body == null ? {} : body));
      req.end();
    } else if (ct.includes("proto") && Buffer.isBuffer(body)) {
      req.write(body);
      req.end();
    } else {
      req.write(JSON.stringify(body == null ? {} : body));
      req.end();
    }
  });
}

const chatBody = (model) => ({
  conversation: [{ text: "Reply with exactly: pong", type: 1 }],
  modelDetails: { modelName: model, maxMode: true },
  requestedModel: { modelId: model },
  modelName: model,
  isChat: true,
});

const wrappedChat = (model) => ({
  streamUnifiedChatRequest: chatBody(model),
});

const UNARY = [
  ["/aiserver.v1.DashboardService/GetMe", {}],
  ["/aiserver.v1.DashboardService/GetSandUsageStatus", {}],
  ["/aiserver.v1.DashboardService/GetHardLimit", {}],
  ["/aiserver.v1.DashboardService/GetTeams", {}],
  ["/aiserver.v1.DashboardService/GetUserOrganizations", {}],
  ["/aiserver.v1.AiService/HealthCheck", {}],
  ["/aiserver.v1.AiService/TimeLeftHealthCheck", {}],
  ["/aiserver.v1.AiService/ServerTime", {}],
  ["/aiserver.v1.AiService/GetUserInfo", {}],
  ["/aiserver.v1.AiService/CountTokens", { text: "hello", modelName: "kimi-k3-max" }],
  ["/aiserver.v1.AiService/GetEffectiveTokenLimit", { modelName: "kimi-k3-max" }],
  ["/aiserver.v1.AiService/CheckUsageBasedPrice", {}],
  ["/aiserver.v1.AiService/CheckFeatureStatus", {}],
  ["/aiserver.v1.AiService/GetCompletion", { prompt: "Reply with exactly: pong", modelName: "kimi-k3-max" }],
  ["/aiserver.v1.AiService/GetSimplePrompt", {}],
  ["/aiserver.v1.AiService/GetChatTitle", { conversation: [{ text: "hello", type: 1 }] }],
  ["/aiserver.v1.HealthService/Ping", {}],
  ["/aiserver.v1.HealthService/Unary", {}],
  ["/aiserver.v1.ServerConfigService/GetServerConfig", {}],
  ["/aiserver.v1.NetworkService/GetPublicIp", {}],
  ["/aiserver.v1.NetworkService/IsConnected", {}],
  ["/aiserver.v1.AuthService/GetEmail", {}],
  ["/aiserver.v1.AuthService/GetUserMeta", {}],
  ["/agent.v1.AgentService/GetDefaultModelForCli", {}],
  ["/agent.v1.AgentService/GetPromptContextUsage", {}],
  ["/agent.v1.AgentService/GetNewChatNudgeParameterizedModelPicker", {}],
  ["/aiserver.v1.CppService/AvailableModels", {}],
  ["/aiserver.v1.MCPRegistryService/GetKnownServers", {}],
  ["/aiserver.v1.ChatService/GetPromptDryRun", wrappedChat("kimi-k3-max")],
  ["/aiserver.v1.ChatService/GetConversationSummary", wrappedChat("kimi-k3-max")],
  ["/aiserver.v1.ChatService/ConvertOALToNAL", {}],
  ["/aiserver.v1.GrokBotService/ListSandBoxes", {}],
  ["/aiserver.v1.GrokBotService/GetSandBoxRunState", {}],
  ["/aiserver.v1.SandBoxService/ListSandBoxes", {}],
];

const STREAMS = [
  ["/aiserver.v1.InferenceService/Stream", chatBody("kimi-k3-max")],
  ["/aiserver.v1.ChatService/StreamUnifiedChatWithTools", wrappedChat("kimi-k3-max")],
  ["/aiserver.v1.ChatService/StreamUnifiedChat", chatBody("kimi-k3-max")],
  ["/aiserver.v1.ChatService/WarmStreamUnifiedChatWithTools", wrappedChat("kimi-k3-max")],
  ["/aiserver.v1.AiService/StreamChat", chatBody("kimi-k3-max")],
  ["/aiserver.v1.AiService/StreamChatContext", chatBody("kimi-k3-max")],
  ["/aiserver.v1.AiService/StreamChatDeepContext", chatBody("kimi-k3-max")],
  ["/aiserver.v1.AiService/StreamChatToolformer", chatBody("kimi-k3-max")],
  ["/aiserver.v1.AiService/StreamGenerate", chatBody("kimi-k3-max")],
  ["/aiserver.v1.AiService/StreamComposer", chatBody("kimi-k3-max")],
  ["/aiserver.v1.AiService/StreamEdit", chatBody("kimi-k3-max")],
  ["/aiserver.v1.ReplayChatService/StreamReplayChat", chatBody("kimi-k3-max")],
  ["/agent.v1.AgentHostService/SendMessage", { text: "Reply with exactly: pong" }],
];

async function main() {
  const token = loadToken();
  const unary = [];
  for (const [rpc, body] of UNARY) {
    unary.push(await call(token, rpc, { body }));
  }

  const streams = [];
  for (const [rpc, body] of STREAMS) {
    streams.push(await call(token, rpc, { body, stream: true }));
  }

  // StreamChat proto vs json: empty proto envelope vs json 415
  streams.push(
    await call(token, "/aiserver.v1.AiService/StreamChat", {
      contentType: "application/connect+proto",
      body: Buffer.from([0, 0, 0, 0, 0]),
      stream: false,
      timeoutMs: 8000,
    })
  );
  streams.push(
    await call(token, "/aiserver.v1.AiService/GetCompletion", {
      contentType: "application/json",
      body: chatBody("kimi-k3-max"),
    })
  );

  const useful = [];
  const rank = (r) => {
    if (r.classified === "ok" && (r.contentLen > 0 || r.reasoningLen > 0 || r.mode === "unary")) return "sand-ok";
    if (r.classified === "exists_needs_body") return "exists-sand";
    if (r.classified === "needs_proto") return "exists-proto";
    if (r.classified === "resource_exhausted") return "sand-quota";
    return null;
  };
  for (const r of [...unary, ...streams]) {
    const value = rank(r);
    if (value) useful.push({ ...r, value });
  }

  const out = {
    token: token.name,
    when: new Date().toISOString(),
    unary,
    streams,
    useful,
  };
  const dest = path.join(__dirname, "high-value-rpc-probe.json");
  fs.writeFileSync(dest, JSON.stringify(out, null, 2));
  const summary = {
    dest,
    unary: unary.map((r) => ({ rpc: r.rpc, classified: r.classified, http: r.http, preview: r.preview })),
    streams: streams.map((r) => ({
      rpc: r.rpc,
      classified: r.classified,
      http: r.http,
      contentLen: r.contentLen,
      preview: r.preview,
    })),
    useful: useful.map((r) => ({ rpc: r.rpc, value: r.value, classified: r.classified, preview: r.preview })),
  };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
