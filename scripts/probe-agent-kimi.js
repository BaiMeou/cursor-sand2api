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

function loadToken() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
  return (data.tokens || data).find((x) => x && x.accessToken);
}

function clip(s, n = 420) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function run(token, label, extra) {
  return new Promise((resolve) => {
    const host = extra.host || "https://api2.cursor.sh";
    const client = http2.connect(host);
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const headers = {
      ":method": "POST",
      ":path": extra.path || "/agent.v1.AgentService/Run",
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token.accessToken}`,
      "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
      "x-cursor-client-version": extra.version || "3.17.21",
      "x-cursor-timezone": "UTC",
      "x-request-id": requestId,
      "user-agent": extra.ua || "connect-es/1.6.1",
    };
    if (extra.type) headers["x-cursor-client-type"] = extra.type;
    if (extra.type === "sand") headers["x-sand-box-namespace"] = "prod";
    const req = client.request(headers);
    req.setTimeout(12000);
    const push = createFrameReader();
    let status = 0;
    let err = "";
    const finish = () => {
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      console.log("\n==", label, "==");
      console.log("http", status, "err", clip(err, 500));
      resolve();
    };
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (c) => {
      for (const frame of push(c)) {
        if (frame.kind === "trailer" && frame.error) err = frame.error + " " + clip(JSON.stringify(frame.trailer), 360);
        const msg = frame.message || {};
        if (msg.error) err = JSON.stringify(msg.error);
      }
    });
    req.on("end", finish);
    req.on("error", (e) => { err = e.message; finish(); });
    req.on("timeout", () => { err = "timeout " + err; finish(); });
    req.write(encodeFrame(extra.body));
  });
}

async function main() {
  const token = loadToken();
  const cid = "probe-" + Date.now();
  const runReq = (modelId, params) => ({
    runRequest: {
      conversationState: {},
      action: { userMessageAction: { userMessage: { text: "Reply with exactly: pong", messageId: "p1" } } },
      modelDetails: { modelId, displayName: modelId, displayNameShort: modelId },
      requestedModel: params ? { modelId, parameters: params } : { modelId },
      conversationId: cid + modelId + (params ? "-p" : ""),
    },
  });
  const kimiParams = [{ id: "reasoning", value: "max" }];
  await run(token, "api2 sand kimi-k3-max", { type: "sand", body: runReq("kimi-k3-max") });
  await run(token, "api2 sand kimi-k3+params", { type: "sand", body: runReq("kimi-k3", kimiParams) });
  await run(token, "api2 glass kimi-k3+params", { type: "glass", body: runReq("kimi-k3", kimiParams) });
  await run(token, "api2 ide kimi-k3+params", { type: "ide", body: runReq("kimi-k3", kimiParams) });
  await run(token, "api2 glass kimi-k3-max", { type: "glass", body: runReq("kimi-k3-max") });
  await run(token, "agentn sand kimi-k3-max", {
    type: "sand",
    host: "https://agentn.api5.cursor.sh",
    body: runReq("kimi-k3-max"),
  });
  await run(token, "agentn glass kimi-k3+params", {
    type: "glass",
    host: "https://agentn.api5.cursor.sh",
    body: runReq("kimi-k3", kimiParams),
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
