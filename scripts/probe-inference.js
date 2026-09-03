#!/usr/bin/env node
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
  return `${Buffer.from(b).toString("base64")}${machineId}${macMachineId ? "/" + macMachineId : ""}`;
}

function loadSandToken() {
  const file = path.join(__dirname, "..", "token.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(data) ? data : data.tokens || [];
  return list.find((x) => x && x.accessToken && x.kind !== "api");
}

function clip(s, n = 400) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function probe(token, label, extra) {
  return new Promise((resolve) => {
    const client = http2.connect("https://api2.cursor.sh");
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const type = extra.type || "sand";
    const headers = {
      ":method": "POST",
      ":path": extra.path || "/aiserver.v1.InferenceService/Stream",
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token.accessToken}`,
      "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
      "x-cursor-client-version": extra.version || "3.18.25",
      "x-cursor-timezone": "UTC",
      "x-request-id": requestId,
      "user-agent": extra.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/3.18.25 Chrome/132.0.6834.210 Electron/34.2.0 Safari/537.36",
    };
    if (type) headers["x-cursor-client-type"] = type;
    if (type === "sand") headers["x-sand-box-namespace"] = "prod";
    const req = client.request(headers);
    req.setTimeout(12000);
    const push = createFrameReader();
    let status = 0;
    let err = "";
    let text = "";
    let keys = [];
    const finish = () => {
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      console.log("\n==", label, "==");
      console.log("http", status, "err", clip(err, 500), "text", clip(text, 300), "keys", keys.join("|"));
      resolve();
    };
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (c) => {
      for (const frame of push(c)) {
        if (frame.kind === "trailer") {
          if (frame.error) err = frame.error + " " + clip(JSON.stringify(frame.trailer), 400);
          continue;
        }
        if (frame.kind === "invalid") { err += " " + frame.error; continue; }
        const msg = frame.message || {};
        if (msg.error) err = JSON.stringify(msg.error);
        keys.push(Object.keys(msg).join(","));
        const inner = msg.inferenceStreamResponse || msg;
        const dump = (obj, prefix) => {
          if (!obj || typeof obj !== "object") return;
          if (typeof obj.text === "string") text += obj.text;
          if (typeof obj.textDelta === "string") text += obj.textDelta;
          if (typeof obj.delta === "string") text += obj.delta;
          for (const [k, v] of Object.entries(obj)) {
            if (k === "text" || k === "textDelta" || k === "delta") continue;
            if (v && typeof v === "object") dump(v, prefix + k + ".");
          }
        };
        dump(inner, "");
        if (inner.thinkingPart && inner.thinkingPart.text) text += "";
        if (keys.length < 20) keys.push(JSON.stringify(inner).slice(0, 180));
      }
    });
    req.on("end", finish);
    req.on("error", (e) => { err = e.message; finish(); });
    req.on("timeout", () => { err = "timeout " + err; finish(); });
    req.write(encodeFrame(extra.body));
    req.end();
  });
}

async function main() {
  const token = loadSandToken();
  if (!token) throw new Error("no sand token");
  const cid = "probe-infer-" + Date.now();
  const bodies = [
    {
      label: "infer kimi full",
      body: {
        messages: [{ role: 1, text: "Reply with exactly: pong" }],
        conversationId: cid + "-kimi",
        requestedModel: { modelId: "kimi-k3-max" },
        modelId: "kimi-k3-max",
      },
    },
    {
      label: "infer claude full",
      body: {
        messages: [{ role: 1, text: "Reply with exactly: pong" }],
        conversationId: cid + "-claude",
        requestedModel: { modelId: "claude-4.5-sonnet" },
        modelId: "claude-4.5-sonnet",
      },
    },
    {
      label: "infer kimi snake_case",
      body: {
        messages: [{ role: 1, text: "Reply with exactly: pong" }],
        conversation_id: cid + "-kimi2",
        requested_model: { model_id: "kimi-k3-max" },
        model_id: "kimi-k3-max",
      },
    },
  ];
  for (const item of bodies) {
    await probe(token, item.label, { body: item.body, type: "sand", version: "3.18.25" });
  }
  await probe(token, "infer kimi ide", {
    body: {
      messages: [{ role: 1, text: "Reply with exactly: pong" }],
      modelId: "kimi-k3-max",
    },
    type: "ide",
    version: "3.18.25",
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
