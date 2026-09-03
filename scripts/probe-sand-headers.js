#!/usr/bin/env node
// One-shot header/path matrix against api2.cursor.sh. Does not restart the proxy.
const http2 = require("http2");
const fs = require("fs");
const path = require("path");
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
  const prefix = Buffer.from(b).toString("base64");
  return macMachineId ? `${prefix}${machineId}/${macMachineId}` : `${prefix}${machineId}`;
}

function loadSandToken(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(data) ? data : data.tokens || data.accounts || [];
  const t = list.find((x) => x && x.accessToken && !String(x.apiKey || x.key || "").startsWith("crsr_"));
  if (!t) throw new Error("no sand JWT in " + file);
  return t;
}

function clip(s, n = 220) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function headers(token, rpcPath, extra) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const h = {
    ":method": "POST",
    ":path": rpcPath,
    "content-type": rpcPath.endsWith("/Run") ? "application/connect+json" : "application/json",
    "connect-protocol-version": "1",
    authorization: `Bearer ${token.accessToken}`,
    "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
    "x-cursor-client-version": extra.version || "3.17.21",
    "x-cursor-timezone": "UTC",
    "x-request-id": requestId,
    "user-agent": "connect-es/1.6.1",
  };
  if (extra.type) h["x-cursor-client-type"] = extra.type;
  if (extra.ns) h["x-sand-box-namespace"] = extra.ns;
  return h;
}

function unary(token, rpcPath, extra, body, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const client = http2.connect("https://api2.cursor.sh");
    client.on("error", (e) => resolve({ ok: false, error: "conn " + e.message }));
    const req = client.request(headers(token, rpcPath, extra));
    req.setTimeout(timeoutMs);
    let text = "";
    let status = 0;
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (c) => { text += c.toString(); });
    req.on("end", () => {
      client.close();
      resolve({ ok: status === 200, status, body: clip(text, 400) });
    });
    req.on("error", (e) => { client.close(); resolve({ ok: false, error: e.message }); });
    req.on("timeout", () => { req.close(); client.close(); resolve({ ok: false, error: "timeout" }); });
    req.write(JSON.stringify(body || {}));
    req.end();
  });
}

function runOnce(token, extra, modelId, timeoutMs = 18000) {
  return new Promise((resolve) => {
    const client = http2.connect("https://api2.cursor.sh");
    client.on("error", (e) => resolve({ ok: false, error: "conn " + e.message }));
    const req = client.request(headers(token, "/agent.v1.AgentService/Run", extra));
    req.setTimeout(timeoutMs);
    const push = createFrameReader();
    let status = 0;
    let err = "";
    let text = "";
    let done = false;
    const finish = (out) => {
      if (done) return;
      done = true;
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      resolve(out);
    };
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (chunk) => {
      for (const frame of push(chunk)) {
        if (frame.kind === "trailer" && frame.error) {
          err = frame.error;
          return finish({ ok: false, status, error: clip(err) });
        }
        const msg = frame.message || {};
        if (msg.error) {
          err = JSON.stringify(msg.error);
          return finish({ ok: false, status, error: clip(err, 400) });
        }
        const iu = msg.interactionUpdate || {};
        if (iu.textDelta) text += String(iu.textDelta);
        if (iu.turnEnded || (iu.message && iu.message.turnEnded)) {
          return finish({ ok: true, status, text: clip(text, 160) });
        }
        if (msg.execServerMessage && msg.execServerMessage.requestContextArgs) {
          req.write(encodeFrame({
            execClientMessage: {
              id: msg.execServerMessage.id,
              execId: msg.execServerMessage.execId,
              requestContextResult: { success: {} },
            },
          }));
        }
      }
    });
    req.on("end", () => finish({ ok: Boolean(text), status, error: clip(err || "eof"), text: clip(text, 160) }));
    req.on("error", (e) => finish({ ok: false, error: e.message }));
    req.on("timeout", () => finish({ ok: false, error: "timeout", text: clip(text, 160) }));
    const model = modelId || "kimi-k3-max";
    req.write(encodeFrame({
      runRequest: {
        conversationState: {},
        action: { userMessageAction: { userMessage: { text: "Reply with exactly: pong", messageId: "probe-1" } } },
        modelDetails: { modelId: model, displayName: model, displayNameShort: model },
        requestedModel: { modelId: model },
        conversationId: "probe-" + Date.now(),
      },
    }));
  });
}

async function main() {
  const file = process.argv[2] || "/opt/cursor-sand2api/token.json";
  const token = loadSandToken(file);
  console.log("token", token.name || "(unnamed)", "machine", Boolean(token.machineId));

  const variants = [
    { name: "current-sand-3.17", type: "sand", ns: "prod", version: "3.17.21" },
    { name: "sand-0.30", type: "sand", ns: "prod", version: "0.30.0" },
    { name: "sand-no-ns", type: "sand", version: "3.17.21" },
    { name: "ide-3.17", type: "ide", version: "3.17.21" },
    { name: "none-3.17", version: "3.17.21" },
  ];

  console.log("\n== GetUsableModels ==");
  for (const v of variants) {
    const r = await unary(token, "/agent.v1.AgentService/GetUsableModels", v, {});
    let n = "?";
    try { n = JSON.parse(r.body).models.length; } catch {}
    console.log(v.name, "status=" + (r.status || r.error), "models=" + n, clip(r.body, 120));
  }

  console.log("\n== AvailableModels sand ==");
  for (const v of [variants[0], variants[3]]) {
    const r = await unary(token, "/aiserver.v1.AiService/AvailableModels", v, { useModelParameters: true });
    console.log(v.name, "status=" + (r.status || r.error), clip(r.body, 160));
  }

  console.log("\n== Run kimi-k3-max ==");
  for (const v of variants) {
    const r = await runOnce(token, v, "kimi-k3-max");
    console.log(v.name, r.ok ? "OK" : "FAIL", "status=" + (r.status || "-"), clip(r.error || r.text || "", 240));
  }

  console.log("\n== Run claude-4.5-sonnet (ide vs sand) ==");
  for (const v of [variants[0], variants[3]]) {
    const r = await runOnce(token, v, "claude-4.5-sonnet");
    console.log(v.name, r.ok ? "OK" : "FAIL", "status=" + (r.status || "-"), clip(r.error || r.text || "", 240));
  }

  const sand = { type: "sand", ns: "prod", version: "0.30.0" };
  const paths = [
    "/aiserver.v1.ChatService/StreamUnifiedChatWithTools",
    "/aiserver.v1.AiService/StreamChat",
    "/aiserver.v1.AiService/StreamComposer",
    "/aiserver.v1.GrokBotService/EnsureSandBox",
    "/aiserver.v1.DashboardService/GetSandUsageStatus",
  ];
  console.log("\n== sand json path sniff ==");
  for (const p of paths) {
    const r = await unary(token, p, sand, {}, 8000);
    console.log(p, "status=" + (r.status || r.error), clip(r.body || r.error, 220));
  }

  console.log("\n== ChatService connect+json empty frame ==");
  await new Promise((resolve) => {
    const client = http2.connect("https://api2.cursor.sh");
    const h = headers(token, "/agent.v1.AgentService/Run", sand);
    h[":path"] = "/aiserver.v1.ChatService/StreamUnifiedChatWithTools";
    h["content-type"] = "application/connect+json";
    const req = client.request(h);
    req.setTimeout(8000);
    let text = "";
    let status = 0;
    req.on("response", (hdr) => { status = Number(hdr[":status"] || 0); });
    req.on("data", (c) => { text += c.toString(); });
    req.on("end", () => {
      client.close();
      console.log("ChatService stream", "status=" + status, clip(text, 300));
      resolve();
    });
    req.on("error", (e) => { client.close(); console.log("ChatService stream error", e.message); resolve(); });
    req.on("timeout", () => { req.close(); client.close(); console.log("ChatService stream timeout"); resolve(); });
    req.write(encodeFrame({}));
    req.end();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
