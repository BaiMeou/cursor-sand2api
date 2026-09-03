#!/usr/bin/env node
const http2 = require("http2");
const fs = require("fs");
const { encodeFrame, createFrameReader } = require("../src/connect-frame");

function generateChecksum(machineId, macMachineId) {
  let k = 165;
  const t = Math.floor(Date.now() / 1e6);
  const b = new Uint8Array([
    (t >> 40) & 255, (t >> 32) & 255, (t >> 24) & 255,
    (t >> 16) & 255, (t >> 8) & 255, t & 255,
  ]);
  for (let i = 0; i < b.length; i++) {
    b[i] = ((b[i] ^ k) + (i % 256)) & 0xff;
    k = b[i];
  }
  return `${Buffer.from(b).toString("base64")}${machineId}${macMachineId ? "/" + macMachineId : ""}`;
}

function loadSandToken(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(data) ? data : data.tokens || data.accounts || [];
  return list.find((x) => x && x.accessToken && !String(x.apiKey || "").startsWith("crsr_"));
}

function clip(s, n = 360) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function send(token, body, label, extra = {}) {
  return new Promise((resolve) => {
    const client = http2.connect("https://api2.cursor.sh");
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const type = extra.type || "sand";
    const headers = {
      ":method": "POST",
      ":path": "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token.accessToken}`,
      "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
      "x-cursor-client-version": extra.version || "3.18.25",
      "x-cursor-timezone": "UTC",
      "x-request-id": requestId,
      "x-cursor-client-os": "win32",
      "x-cursor-client-arch": "x64",
      "x-cursor-client-device-type": "desktop",
      "x-ghost-mode": "false",
      "user-agent": extra.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/3.18.25 Chrome/132.0.6834.210 Electron/34.2.0 Safari/537.36",
    };
    if (type) headers["x-cursor-client-type"] = type;
    if (type === "sand") headers["x-sand-box-namespace"] = "prod";
    const req = client.request(headers);
    req.setTimeout(15000);
    const push = createFrameReader();
    let status = 0;
    let text = "";
    let err = "";
    let chunks = [];
    const finish = () => {
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      console.log("\n==", label, "==");
      console.log("http", status, "text", clip(text, 160), "err", clip(err || chunks.join(" | "), 800));
      resolve();
    };
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (c) => {
      for (const frame of push(c)) {
        if (frame.kind === "trailer") {
          if (frame.error) err = frame.error + " " + clip(JSON.stringify(frame.trailer), 500);
          else chunks.push("trailer " + clip(JSON.stringify(frame.trailer), 200));
          continue;
        }
        if (frame.kind === "invalid") { chunks.push(frame.error); continue; }
        const msg = frame.message || {};
        if (msg.error) err = JSON.stringify(msg.error);
        const keys = Object.keys(msg).join(",");
        chunks.push(keys);
        const inner = msg.streamUnifiedChatResponse || msg.streamUnifiedChatResponseWithTools || msg;
        const nested = inner.streamUnifiedChatResponse || inner;
        if (nested && nested.text) text += nested.text;
        if (typeof inner.text === "string") text += inner.text;
      }
    });
    req.on("end", finish);
    req.on("error", (e) => { err = e.message; finish(); });
    req.on("timeout", () => { err = "timeout"; finish(); });
    req.write(encodeFrame(body));
    req.end();
  });
}

function uvarint(n) {
  const out = [];
  n = Number(n);
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}
function strField(id, s) {
  const b = Buffer.from(String(s), "utf8");
  return Buffer.concat([uvarint((id << 3) | 2), uvarint(b.length), b]);
}
function msgField(id, inner) {
  return Buffer.concat([uvarint((id << 3) | 2), uvarint(inner.length), inner]);
}
function varintField(id, n) {
  return Buffer.concat([uvarint((id << 3) | 0), uvarint(n)]);
}
function encodeChatProto(modelName, text, conversationId) {
  const conv = Buffer.concat([strField(1, text), varintField(2, 1)]);
  const model = strField(1, modelName);
  const request = Buffer.concat([
    msgField(1, conv),
    msgField(5, model),
    varintField(22, 1),
    strField(23, conversationId),
  ]);
  return msgField(1, request);
}

function sendProto(token, modelName, label) {
  return new Promise((resolve) => {
    const inner = encodeChatProto(modelName, "Reply with exactly: pong", "p-" + Date.now());
    const frame = Buffer.alloc(5 + inner.length);
    frame[0] = 0;
    frame.writeUInt32BE(inner.length, 1);
    inner.copy(frame, 5);
    const client = http2.connect("https://api2.cursor.sh");
    const requestId = `${Date.now()}-proto`;
    const req = client.request({
      ":method": "POST",
      ":path": "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token.accessToken}`,
      "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
      "x-cursor-client-version": "3.18.25",
      "x-cursor-client-type": "sand",
      "x-sand-box-namespace": "prod",
      "x-cursor-timezone": "UTC",
      "x-cursor-client-os": "win32",
      "x-cursor-client-device-type": "desktop",
      "x-request-id": requestId,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/3.18.25 Chrome/132.0.6834.210 Electron/34.2.0 Safari/537.36",
    });
    req.setTimeout(15000);
    let status = 0;
    let raw = Buffer.alloc(0);
    const finish = () => {
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      const s = raw.toString("utf8");
      console.log("\n== proto", label, "==");
      console.log("http", status, clip(s, 500));
      resolve();
    };
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (c) => { raw = Buffer.concat([raw, c]); });
    req.on("end", finish);
    req.on("error", (e) => { console.log("proto error", e.message); resolve(); });
    req.on("timeout", () => { req.destroy(); console.log("proto timeout"); resolve(); });
    req.write(frame);
    req.end();
  });
}

async function main() {
  const token = loadSandToken(process.argv[2] || "/opt/cursor-sand2api/token.json");
  const cid = "probe-" + Date.now();
  const box = await new Promise((resolve) => {
    const client = http2.connect("https://api2.cursor.sh");
    const requestId = `${Date.now()}-box`;
    const req = client.request({
      ":method": "POST",
      ":path": "/aiserver.v1.GrokBotService/EnsureSandBox",
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token.accessToken}`,
      "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
      "x-cursor-client-version": "0.30.0",
      "x-cursor-client-type": "sand",
      "x-sand-box-namespace": "prod",
      "x-cursor-timezone": "UTC",
      "x-request-id": requestId,
      "user-agent": "connect-es/1.6.1",
    });
    req.setTimeout(12000);
    let text = "";
    req.on("data", (c) => { text += c.toString(); });
    req.on("end", () => { client.close(); resolve(text); });
    req.on("error", (e) => { client.close(); resolve(JSON.stringify({ error: e.message })); });
    req.on("timeout", () => { req.close(); client.close(); resolve('{"error":"timeout"}'); });
    req.write("{}");
    req.end();
  });
  console.log("EnsureSandBox", clip(box, 1200));
  let parsed = {};
  try { parsed = JSON.parse(box); } catch {}
  const gateway = parsed.gatewayUrl || parsed.gateway_url;
  const gtok = parsed.gatewayToken || parsed.gateway_token;
  const ntok = parsed.networkToken || parsed.network_token;
  if (gateway && gtok) {
    const https = require("https");
    await new Promise((resolve) => {
      const url = new URL(String(gateway).replace(/\/$/, "") + "/api/sendPrompt");
      const payload = JSON.stringify({ prompt: "Reply with exactly: pong", agentId: parsed.agentId || parsed.agent_id || "" });
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          authorization: "Bearer " + gtok,
          "x-anyrun-network-token": ntok || "",
        },
        timeout: 15000,
      }, (res) => {
        let t = "";
        res.on("data", (c) => { t += c.toString(); });
        res.on("end", () => { console.log("sendPrompt", res.statusCode, clip(t, 500)); resolve(); });
      });
      req.on("error", (e) => { console.log("sendPrompt error", e.message); resolve(); });
      req.on("timeout", () => { req.destroy(); console.log("sendPrompt timeout"); resolve(); });
      req.write(payload);
      req.end();
    });
  }
  const convHuman = { text: "Reply with exactly: pong", type: 1 };
  const convEnum = { text: "Reply with exactly: pong", type: "MESSAGE_TYPE_HUMAN" };
  const convRole = { text: "Reply with exactly: pong", role: "user" };
  const model = { modelName: "kimi-k3-max" };
  const body = (modelName, extra = {}) => ({
    streamUnifiedChatRequest: {
      conversation: [convHuman],
      modelDetails: { modelName, maxMode: true },
      isChat: true,
      isAgentic: false,
      conversationId: cid + modelName,
      unifiedMode: 1,
      chatMode: "chat",
      environmentInfo: { os: "win32", arch: "x64", workspaceUris: [] },
      ...extra,
    },
  });
  await sendProto(token, "kimi-k3-max", "sand kimi");
  await send(token, body("kimi-k3-max"), "3.18.25 sand kimi", { version: "3.18.25", type: "sand" });
  await send(token, body("claude-4.5-sonnet"), "3.18.25 sand claude", { version: "3.18.25", type: "sand" });
  await send(token, body("kimi-k3-max"), "3.18.25 ide kimi", { version: "3.18.25", type: "ide" });

  await new Promise((resolve) => {
    const client = http2.connect("https://api2.cursor.sh");
    const requestId = `${Date.now()}-run`;
    const req = client.request({
      ":method": "POST",
      ":path": "/agent.v1.AgentService/Run",
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token.accessToken}`,
      "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
      "x-cursor-client-version": "3.18.25",
      "x-cursor-client-type": "sand",
      "x-sand-box-namespace": "prod",
      "x-cursor-timezone": "UTC",
      "x-request-id": requestId,
      "user-agent": "connect-es/1.6.1",
    });
    req.setTimeout(12000);
    const push = createFrameReader();
    let err = "";
    let text = "";
    const finish = () => {
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      console.log("\n== AgentService Run 3.18.25 sand kimi ==");
      console.log(clip(err || text, 400));
      resolve();
    };
    req.on("data", (c) => {
      for (const frame of push(c)) {
        if (frame.kind === "trailer" && frame.error) err = frame.error;
        const msg = frame.message || {};
        if (msg.error) err = JSON.stringify(msg.error);
        const iu = (msg.interactionUpdate || {});
        if (iu.textDelta) text += String(iu.textDelta);
      }
    });
    req.on("end", finish);
    req.on("error", (e) => { err = e.message; finish(); });
    req.on("timeout", () => { err = "timeout " + text; finish(); });
    req.write(encodeFrame({
      runRequest: {
        conversationState: {},
        action: { userMessageAction: { userMessage: { text: "Reply with exactly: pong", messageId: "p1" } } },
        modelDetails: { modelId: "kimi-k3-max", displayName: "kimi-k3-max", displayNameShort: "kimi-k3-max" },
        requestedModel: { modelId: "kimi-k3-max" },
        conversationId: "probe-run-" + Date.now(),
      },
    }));
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
