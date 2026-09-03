#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { createRun } = require("../src/cursor-client");

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
const token = (data.tokens || data).find((x) => x && x.accessToken);
if (!token) throw new Error("no sand token");

async function ping(modelId) {
  process.stdout.write(`\n== ${modelId} ==\n`);
  const run = createRun(token, "Reply with exactly: pong", modelId, { mode: "none" });
  const ev = await run.wait();
  console.log("type", ev.type, "error", ev.error || "", "text", JSON.stringify((ev.text || "").slice(0, 200)), "thinking", (ev.thinking || "").length);
}

(async () => {
  await ping("kimi-k3-max");
  await ping("claude-4.5-sonnet");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
