#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { createRun } = require("../src/cursor-client");
const official = require("../src/official-client");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
const tokens = data.tokens || data;
const sands = tokens.filter((x) => x && x.accessToken && x.kind !== "api");
const primary = sands[0];
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

function clip(s, n = 240) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function ping(label, factory, token, model, tools) {
  const started = Date.now();
  const prompt = tools
    ? "What is the weather in Osaka right now? You MUST call get_weather. Do not answer in prose first."
    : "Reply with exactly: pong";
  try {
    const run = factory(token, prompt, model, {
      mode: "client",
      toolChoice: tools ? "required" : "none",
      openaiTools: tools ? weather : [],
      inferenceUserText: prompt,
    });
    const ev = await Promise.race([
      run.wait(),
      new Promise((resolve) =>
        setTimeout(() => {
          try { run.abort(); } catch {}
          resolve({ type: "error", error: "timeout" });
        }, 40000)
      ),
    ]);
    return {
      label,
      model,
      type: ev.type,
      error: clip(ev.error, 300),
      text: clip(ev.text, 100),
      reasoningLen: (ev.thinking || "").length,
      tools: (ev.tool_calls || []).map((c) => ({
        name: c.function && c.function.name,
        arguments: clip(c.function && c.function.arguments, 80),
      })),
      ms: Date.now() - started,
    };
  } catch (e) {
    return { label, model, type: "throw", error: clip(e.message, 300), ms: Date.now() - started };
  }
}

async function main() {
  const rows = [];
  rows.push(await ping("sand-fable-5-1", createRun, primary, "claude-fable-5-1", false));
  rows.push(await ping("official-sonnet-5-notools", official.createRun, crsr, "claude-sonnet-5", false));
  rows.push(await ping("official-sonnet-5-tools", official.createRun, crsr, "claude-sonnet-5", true));
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
