#!/usr/bin/env node
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

function clip(s, n = 240) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function headers(token, rpcPath) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    ":method": "POST",
    ":path": rpcPath,
    "content-type": "application/connect+json",
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

function stream(token, rpcPath, body) {
  return new Promise((resolve) => {
    const started = Date.now();
    const client = http2.connect("https://api2.cursor.sh");
    client.on("error", (e) => resolve({ rpc: rpcPath, error: e.message, ms: Date.now() - started }));
    const req = client.request(headers(token, rpcPath));
    req.setTimeout(15000);
    const push = createFrameReader();
    let status = 0;
    let text = "";
    let err = "";
    let keys = [];
    const finish = () => {
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      resolve({
        rpc: rpcPath,
        http: status,
        err: clip(err),
        text: clip(text, 300),
        contentLen: text.length,
        keys,
        ms: Date.now() - started,
      });
    };
    req.on("response", (h) => { status = Number(h[":status"] || 0); });
    req.on("data", (c) => {
      for (const frame of push(c)) {
        if (frame.kind === "trailer") {
          if (frame.error) err = frame.error;
          continue;
        }
        const msg = frame.message || {};
        keys.push(...Object.keys(msg));
        if (msg.error) err = JSON.stringify(msg.error);
        if (typeof msg.text === "string") text += msg.text;
        if (msg.textDelta) text += partText(msg.textDelta);
        const part = msg.textPart || msg.editPart || msg.generatePart;
        if (part) text += partText(part);
      }
    });
    req.on("end", finish);
    req.on("error", (e) => { err = e.message; finish(); });
    req.on("timeout", () => { err = err || "timeout"; finish(); });
    req.write(encodeFrame(body));
    req.end();
  });
}

async function main() {
  const token = loadToken();
  const model = "kimi-k3-max";
  const cmdk = {
    query: "Reply with exactly: pong",
    sessionId: "probe-stream-generate",
    modelDetails: { modelName: model, maxMode: true },
    conversation: [{ text: "Reply with exactly: pong", type: 1 }],
    currentFile: {
      relativeWorkspacePath: "hello.txt",
      contents: "console.log('hi');\n",
      cursorPosition: { line: 1, column: 1 },
      languageId: "javascript",
    },
    workspaceRootPath: "/tmp/probe",
  };
  const rows = [];
  rows.push(await stream(token, "/aiserver.v1.AiService/StreamGenerate", cmdk));
  rows.push(await stream(token, "/aiserver.v1.AiService/StreamEdit", cmdk));
  rows.push(await stream(token, "/aiserver.v1.AiService/StreamInlineLongCompletion", cmdk));
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
