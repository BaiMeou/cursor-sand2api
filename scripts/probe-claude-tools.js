#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { createRun } = require("../src/cursor-client");
const official = require("../src/official-client");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
const tokens = data.tokens || data;
const sands = tokens.filter((x) => x && x.accessToken && x.kind !== "api");
const primary = sands[0];
const secondary = sands[1];
const crsr = tokens.find((x) => x.kind === "api" && x.apiKey);

const weather = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

function clip(s, n = 220) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function ping(label, factory, token, model, opts = {}) {
  const started = Date.now();
  try {
    const run = factory(token, "Reply with exactly: pong", model, {
      conversationId: `probe-${Date.now()}`,
      mode: "client",
      toolChoice: opts.tools ? "required" : "none",
      openaiTools: opts.tools ? weather : [],
      inferenceUserText: opts.tools
        ? "What is the weather in Osaka? Call get_weather. Reply with exactly: pong only after the tool."
        : "Reply with exactly: pong",
      ...opts.extra,
    });
    const ev = await Promise.race([
      run.wait(),
      new Promise((resolve) =>
        setTimeout(() => {
          try { run.abort(); } catch {}
          resolve({ type: "error", error: "timeout" });
        }, opts.timeoutMs || 25000)
      ),
    ]);
    return {
      label,
      model,
      type: ev.type,
      error: clip(ev.error, 280),
      text: clip(ev.text, 80),
      reasoningLen: (ev.thinking || "").length,
      tools: (ev.tool_calls || []).map((c) => c.function && c.function.name),
      ms: Date.now() - started,
    };
  } catch (e) {
    return { label, model, type: "throw", error: clip(e.message, 280), ms: Date.now() - started };
  }
}

async function main() {
  const rows = [];
  const sandModels = [
    "claude-sonnet-5",
    "claude-sonnet-5-thinking-high",
    "claude-4.5-sonnet",
    "claude-haiku-4-5",
    "claude-opus-4-8",
    "claude-fable-5.1",
  ];
  for (const model of sandModels) {
    rows.push(await ping(`sand-primary-notools ${model}`, createRun, primary, model, { tools: false, timeoutMs: 12000 }));
  }
  const firstOk = rows.find((r) => r.type === "done" && /pong/i.test(r.text || ""));
  const firstAlive = rows.find((r) => r.type !== "error" && r.type !== "throw");
  const toolTarget = (firstOk || firstAlive || rows[0]).model;
  rows.push(await ping(`sand-primary-tools ${toolTarget}`, createRun, primary, toolTarget, { tools: true, timeoutMs: 20000 }));
  if (secondary) {
    rows.push(await ping("sand-secondary-notools claude-sonnet-5", createRun, secondary, "claude-sonnet-5", { tools: false, timeoutMs: 12000 }));
    rows.push(await ping("sand-secondary-tools claude-sonnet-5", createRun, secondary, "claude-sonnet-5", { tools: true, timeoutMs: 15000 }));
  }
  if (crsr) {
    rows.push(await ping("official-notools claude-4.5-sonnet", official.createRun, crsr, "claude-4.5-sonnet", { tools: false, timeoutMs: 25000 }));
    rows.push(await ping("official-tools claude-4.5-sonnet", official.createRun, crsr, "claude-4.5-sonnet", { tools: true, timeoutMs: 25000 }));
  }
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
