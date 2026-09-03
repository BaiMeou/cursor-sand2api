#!/usr/bin/env node
const fs = require("fs");
const { workbenchPath } = require("./cursor-workbench");
const s = fs.readFileSync(workbenchPath(), "utf8");
const i = s.indexOf('makeMessageType("aiserver.v1.ConversationMessage"');
const j = s.indexOf('makeMessageType("aiserver.v1.InferenceMessage"');
const k = s.indexOf('makeMessageType("aiserver.v1.ChatMessage"');
for (const [n, idx] of [
  ["ConversationMessage", i],
  ["InferenceMessage", j],
  ["ChatMessage", k],
]) {
  console.log("====", n, idx);
  if (idx >= 0) console.log(s.slice(idx, idx + 1800).replace(/\s+/g, " "));
}
const img = s.indexOf('makeMessageType("aiserver.v1.ImageProto"');
console.log("==== ImageProto", img);
if (img >= 0) console.log(s.slice(img, img + 800).replace(/\s+/g, " "));
