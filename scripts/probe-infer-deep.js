#!/usr/bin/env node
const http2 = require("http2");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { encodeFrame, createFrameReader } = require("../src/connect-frame");
const { generateChecksum } = require("../src/cursor-client");

const WEATHER = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

function loadToken() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
  const list = Array.isArray(data) ? data : data.tokens || [];
  const name = process.env.SAND_TOKEN_NAME;
  const sand = list.filter((x) => x && x.accessToken && x.kind !== "api");
  if (name) return sand.find((x) => x.name === name) || sand[0];
  return sand[0];
}

function clip(s, n = 220) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

function summarize(obj, depth = 0) {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    if (obj.length > 6) return { _len: obj.length, _head: obj.slice(0, 3).map((x) => summarize(x, depth + 1)) };
    return obj.map((x) => summarize(x, depth + 1));
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.length > 180) out[k] = v.slice(0, 180) + `…(${v.length})`;
    else if (depth >= 3) out[k] = typeof v;
    else out[k] = summarize(v, depth + 1);
  }
  return out;
}

function stream(token, body, extra = {}) {
  return new Promise((resolve) => {
    const client = http2.connect(process.env.CURSOR_BASE_URL || "https://api2.cursor.sh");
    client.on("error", () => {});
    const requestId = uuidv4();
    const headers = {
      ":method": "POST",
      ":path": extra.path || "/aiserver.v1.InferenceService/Stream",
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token.accessToken}`,
      "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
      "x-cursor-client-version": extra.version || "3.17.21",
      "x-cursor-timezone": "UTC",
      "x-request-id": requestId,
      "x-original-request-id": requestId,
      "user-agent": extra.ua || "connect-es/1.6.1",
      "x-cursor-client-type": extra.type || "sand",
    };
    if ((extra.type || "sand") === "sand") headers["x-sand-box-namespace"] = "prod";
    if (extra.allowedTools) headers["x-cursor-agent-allowed-tools"] = extra.allowedTools;
    const req = client.request(headers);
    req.setTimeout(extra.timeout || 45000);
    const push = createFrameReader();
    const frames = [];
    let status = 0;
    let trailer = "";
    const finish = () => {
      try { req.close(); } catch {}
      try { client.close(); } catch {}
      const text = [];
      const think = [];
      const tools = [];
      const keys = [];
      const errors = [];
      const usage = [];
      for (const f of frames) {
        if (f.kind === "trailer") {
          if (f.error) trailer = f.error;
          continue;
        }
        if (f.kind === "invalid") {
          errors.push(f.error);
          continue;
        }
        const msg = f.message || {};
        keys.push(Object.keys(msg).join(",") || "(empty)");
        if (msg.error) errors.push(JSON.stringify(msg.error).slice(0, 400));
        const part = msg.textPart || msg.text_part;
        if (part && part.text) text.push(part.text);
        const th = msg.thinkingPart || msg.thinking_part;
        if (th && th.text) think.push(th.text);
        const tool = msg.toolCallPart || msg.tool_call_part;
        if (tool) tools.push(tool);
        if (msg.usage || msg.extendedUsage || msg.extended_usage) {
          usage.push(msg.usage || msg.extendedUsage || msg.extended_usage);
        }
      }
      resolve({
        status,
        trailer: clip(trailer, 400),
        errors,
        keys,
        text: text.join(""),
        think: think.join(""),
        tools,
        usage,
        frames: frames.map((f) => (f.kind === "message" ? summarize(f.message) : f)).slice(0, 40),
        nframes: frames.length,
      });
    };
    req.on("response", (h) => {
      status = Number(h[":status"] || 0);
    });
    req.on("data", (c) => {
      for (const frame of push(c)) frames.push(frame);
    });
    req.on("end", finish);
    req.on("error", (e) => {
      trailer = e.message;
      finish();
    });
    req.on("timeout", () => {
      trailer = "timeout " + trailer;
      finish();
    });
    req.write(encodeFrame(body));
    req.end();
  });
}

function unary(token, path, body) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(process.env.CURSOR_BASE_URL || "https://api2.cursor.sh");
    client.on("error", () => {});
    const requestId = uuidv4();
    const req = client.request({
      ":method": "POST",
      ":path": path,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      authorization: `Bearer ${token.accessToken}`,
      "x-cursor-checksum": generateChecksum(token.machineId || "", token.macMachineId || ""),
      "x-cursor-client-version": "3.17.21",
      "x-request-id": requestId,
      "x-cursor-client-type": "sand",
      "x-sand-box-namespace": "prod",
      "user-agent": "connect-es/1.6.1",
    });
    req.setTimeout(20000);
    let text = "";
    req.on("data", (c) => (text += c.toString()));
    req.on("end", () => {
      client.close();
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error(`${path} not json: ${text.slice(0, 200)}`));
      }
    });
    req.on("error", (e) => {
      client.close();
      reject(e);
    });
    req.on("timeout", () => {
      req.close();
      client.close();
      reject(new Error("timeout"));
    });
    req.write(JSON.stringify(body || {}));
    req.end();
  });
}

function printRun(label, r) {
  console.log("\n==", label, "==");
  console.log("http", r.status, "frames", r.nframes, "trailer", r.trailer || "-");
  if (r.errors.length) console.log("err", r.errors.map((e) => clip(e, 240)).join(" | "));
  const keyCounts = {};
  for (const k of r.keys) keyCounts[k] = (keyCounts[k] || 0) + 1;
  console.log("keys", JSON.stringify(keyCounts));
  console.log("text", JSON.stringify(clip(r.text, 240)), "len", r.text.length);
  console.log("think", JSON.stringify(clip(r.think, 240)), "len", r.think.length);
  console.log("tools", r.tools.length, JSON.stringify(r.tools.slice(0, 4)).slice(0, 500));
  if (r.usage.length) console.log("usage", JSON.stringify(r.usage[r.usage.length - 1]).slice(0, 300));
}

async function main() {
  const token = loadToken();
  if (!token) throw new Error("no sand token");
  console.log("token", token.name);

  let usable = [];
  try {
    const models = await unary(token, "/agent.v1.AgentService/GetUsableModels", {});
    usable = (models.models || []).map((m) => m.name || m.modelId || m.id).filter(Boolean);
    const fable = usable.filter((n) => /fable/i.test(n));
    console.log("usable", usable.length, "fable", fable.join(", ") || "(none)");
  } catch (e) {
    console.log("usable failed", e.message);
  }

  const fableIds = [
    "claude-fable-5.1",
    "claude-fable-5-1",
    "claude-fable-5-1-thinking-max",
    "claude-fable-5-1-thinking-high",
    "claude-fable-5-1-max",
    "claude-fable-5.1-thinking-max",
    "claude-fable-5-1-thinking",
  ].filter((id, i, a) => a.indexOf(id) === i);
  const fromCatalog = usable.filter((n) => /fable/i.test(n));
  const tryIds = [...new Set([...fromCatalog, ...fableIds])];

  const cid = () => "deep-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  const out = [];

  const experiments = [];

  experiments.push({
    label: "kimi pong no-tools no-system",
    body: {
      messages: [{ role: 1, text: "Reply with exactly: pong" }],
      conversationId: cid(),
      requestedModel: { modelId: "kimi-k3-max" },
      modelId: "kimi-k3-max",
    },
  });

  experiments.push({
    label: "kimi pong with caller system",
    body: {
      messages: [
        { role: 4, text: "You are a terse assistant. Never mention being an AI." },
        { role: 1, text: "Reply with exactly: pong" },
      ],
      conversationId: cid(),
      requestedModel: { modelId: "kimi-k3-max" },
      modelId: "kimi-k3-max",
    },
  });

  experiments.push({
    label: "kimi weather tools no converter prompt",
    body: {
      messages: [{ role: 1, text: "What is the weather in Osaka right now? Call get_weather." }],
      conversationId: cid(),
      requestedModel: { modelId: "kimi-k3-max" },
      modelId: "kimi-k3-max",
      tools: [WEATHER],
    },
  });

  for (const modelId of tryIds.slice(0, 8)) {
    experiments.push({
      label: `fable ping ${modelId}`,
      body: {
        messages: [{ role: 1, text: "Reply with exactly: pong" }],
        conversationId: cid(),
        requestedModel: { modelId },
        modelId,
      },
    });
  }

  for (const item of experiments) {
    const r = await stream(token, item.body);
    printRun(item.label, r);
    out.push({ label: item.label, modelId: item.body.modelId, ...r, bodyKeys: Object.keys(item.body) });
    if (/fable ping/.test(item.label) && r.text && /pong/i.test(r.text) && !r.errors.length && !r.trailer) {
      // lock this id for tool probes
      out._fable = item.body.modelId;
    }
  }

  const fableOk =
    out._fable ||
    (out.find((x) => /fable ping/.test(x.label) && x.text && !x.errors.length && !x.trailer) || {}).modelId ||
    fromCatalog[0] ||
    "claude-fable-5-1-thinking-max";

  console.log("\n>> using fable id", fableOk);

  const weatherCid = cid();
  const tool1 = await stream(token, {
    messages: [
      { role: 4, text: "Be brief." },
      { role: 1, text: "What is the weather in Osaka right now? You MUST call get_weather. Do not guess." },
    ],
    conversationId: weatherCid,
    requestedModel: { modelId: fableOk },
    modelId: fableOk,
    tools: [WEATHER],
  });
  printRun(`fable tools turn1 ${fableOk}`, tool1);
  out.push({ label: `fable tools turn1 ${fableOk}`, ...tool1 });

  const lastTool = tool1.tools.filter((t) => t.isComplete || t.is_complete).slice(-1)[0] || tool1.tools.slice(-1)[0];
  if (lastTool) {
    const args = typeof lastTool.args === "string" ? lastTool.args : JSON.stringify(lastTool.args || {});
    const tool2 = await stream(token, {
      messages: [
        { role: 4, text: "Be brief." },
        { role: 1, text: "What is the weather in Osaka right now? You MUST call get_weather. Do not guess." },
        {
          role: 2,
          text: tool1.text || "",
          toolCalls: [
            {
              toolCallId: lastTool.toolCallId || lastTool.tool_call_id,
              toolName: lastTool.toolName || lastTool.tool_name,
              args: (() => {
                try {
                  return JSON.parse(args);
                } catch {
                  return { city: "Osaka" };
                }
              })(),
            },
          ],
        },
        {
          role: 3,
          toolContent: {
            parts: [
              {
                toolCallId: lastTool.toolCallId || lastTool.tool_call_id,
                toolName: lastTool.toolName || lastTool.tool_name,
                result: { city: "Osaka", temp_c: 31, condition: "sunny" },
                isError: false,
              },
            ],
          },
        },
      ],
      conversationId: weatherCid,
      requestedModel: { modelId: fableOk },
      modelId: fableOk,
      tools: [WEATHER],
    });
    printRun(`fable tools turn2 ${fableOk}`, tool2);
    out.push({ label: `fable tools turn2 ${fableOk}`, ...tool2 });
  } else {
    console.log("no toolCallPart on turn1, skip follow-up");
  }

  // Same conversationId vs new; extra fields probe on kimi (cheaper)
  const extra = await stream(token, {
    messages: [{ role: 1, text: "Reply with exactly: pong" }],
    conversationId: cid(),
    requestedModel: { modelId: "kimi-k3-max", maxMode: true },
    modelId: "kimi-k3-max",
    modelConfig: { maxTokens: 32 },
  });
  printRun("kimi modelConfig maxTokens+maxMode", extra);
  out.push({ label: "kimi modelConfig", ...extra });

  const file = path.join(__dirname, "..", "_tmp_infer_deep.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log("\nwrote", file);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
