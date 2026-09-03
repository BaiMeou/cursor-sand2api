#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const official = require("../src/official-client");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "token.json"), "utf8"));
const crsr = (data.tokens || data).find((x) => x.kind === "api" && x.apiKey);
(async () => {
  const run = official.createRun(crsr, "Reply with exactly: pong", "kimi-k3", { mode: "none", toolChoice: "none" });
  const ev = await Promise.race([
    run.wait(),
    new Promise((r) => setTimeout(() => r({ type: "error", error: "timeout" }), 25000)),
  ]);
  console.log(JSON.stringify({ type: ev.type, error: ev.error, text: (ev.text || "").slice(0, 80) }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
