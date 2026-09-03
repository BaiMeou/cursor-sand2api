#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { createRun } = require("../src/cursor-client");
const history = require("../src/history");
const map = require("../src/openai-map");
const { extraToolsPrompt } = require("../src/openai-map");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
const token = (data.tokens || data).find((x) => x && x.accessToken && x.kind !== "api");
if (!token) throw new Error("no sand token");

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city. Always call this instead of guessing.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  },
];
const toolNames = map.toolNameMap(tools);
const system = extraToolsPrompt(tools, "", true, false);
const openaiMessages = [
  {
    role: "user",
    content: "What is the weather in Osaka right now? You MUST call get_weather. Do not answer without the tool.",
  },
];

function clip(s, n = 240) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function turn(label, messages) {
  const built = history.buildTurnInput(messages, { systemAsHistory: true });
  const run = createRun(token, system + (built.userText || ""), "kimi-k3-max", {
    mode: "client",
    toolChoice: "required",
    openaiTools: tools,
    toolNames,
    rootMessages: built.rootMessages,
    inferenceUserText: built.userText,
    inferenceSystem: system,
    hasCustomTools: true,
  });
  const ev = await run.wait();
  const calls = (ev.tool_calls || []).map((c) => ({
    id: c.id,
    name: c.function && c.function.name,
    arguments: clip(c.function && c.function.arguments, 180),
  }));
  console.log("==", label, "==");
  console.log("type", ev.type, "error", clip(ev.error, 300));
  console.log("text", clip(ev.text, 200), "thinking", (ev.thinking || "").length);
  console.log("tools", calls.length, JSON.stringify(calls));
  return ev;
}

(async () => {
  const first = await turn("turn1", openaiMessages);
  if (first.type !== "tool_calls" || !(first.tool_calls || []).length) {
    process.exitCode = 2;
    return;
  }
  const call = first.tool_calls[0];
  openaiMessages.push({
    role: "assistant",
    content: first.text || null,
    tool_calls: first.tool_calls,
  });
  openaiMessages.push({
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content: JSON.stringify({ city: "Osaka", temp_c: 31, condition: "sunny" }),
  });
  const second = await turn("turn2", openaiMessages);
  if (second.type === "error") process.exitCode = 3;
  else if (second.type === "tool_calls") process.exitCode = 0;
  else if (second.type === "done" && /31|sunny|Osaka/i.test(second.text || "")) process.exitCode = 0;
  else process.exitCode = 4;
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
