#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { createRun } = require("../src/cursor-client");
const history = require("../src/history");
const map = require("../src/openai-map");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
const token = (data.tokens || data).find((x) => x && x.accessToken && x.kind !== "api");
if (!token) throw new Error("no sand token");

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];
const toolNames = map.toolNameMap(tools);
const system = map.extraToolsPrompt(tools, "", true, false);

function clip(s, n = 220) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function runOnce(label, userText, extra = {}) {
  const messages = [{ role: "user", content: userText }];
  const built = history.buildTurnInput(messages, { systemAsHistory: true });
  const run = createRun(token, system + (built.userText || ""), "kimi-k3-max", {
    mode: "client",
    toolChoice: extra.toolChoice || "auto",
    openaiTools: extra.noDeclare ? [] : tools,
    toolNames,
    rootMessages: built.rootMessages,
    inferenceUserText: built.userText,
    inferenceSystem: extra.noDeclare ? map.extraToolsPrompt([], "", false, false) : system,
    hasCustomTools: !extra.noDeclare,
  });
  const ev = await run.wait();
  const calls = (ev.tool_calls || []).map((c) => ({
    name: c.function && c.function.name,
    arguments: clip(c.function && c.function.arguments, 120),
  }));
  console.log(
    "==",
    label,
    "== type",
    ev.type,
    "err",
    clip(ev.error, 180),
    "text",
    JSON.stringify(clip(ev.text, 160)),
    "think",
    (ev.thinking || "").length,
    "tools",
    JSON.stringify(calls)
  );
  return ev;
}

(async () => {
  await runOnce("no-tools-pong", "Reply with exactly: pong", { noDeclare: true });
  await runOnce("tools-auto-pong", "Reply with exactly: pong");
  await runOnce("tools-auto-weather", "What is the weather in Osaka right now?");
  await runOnce("tools-none-weather", "What is the weather in Osaka right now?", { toolChoice: "none" });
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
