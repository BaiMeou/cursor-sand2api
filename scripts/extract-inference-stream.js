#!/usr/bin/env node
const fs = require("fs");
const { workbenchPath } = require("./cursor-workbench");
const s = fs.readFileSync(workbenchPath(), "utf8");

function typeBlock(typeName, n = 2500) {
  const needle = `makeMessageType("${typeName}"`;
  const i = s.indexOf(needle);
  if (i < 0) return { i, text: null };
  return { i, text: s.slice(i, i + n).replace(/\s+/g, " ") };
}

const names = [
  "aiserver.v1.InferenceStreamRequest",
  "aiserver.v1.StreamInferenceRequest",
  "aiserver.v1.InferenceRequest",
  "aiserver.v1.AgenticComposerMessage",
  "aiserver.v1.ConversationMessage",
  "aiserver.v1.ImageProto",
  "agent.v1.SelectedImage",
  "agent.v1.SelectedContext",
];

for (const n of names) {
  const b = typeBlock(n, 2200);
  console.log("====", n, b.i);
  if (b.text) console.log(b.text.slice(0, 1800));
}

const needles = [
  "InferenceService/Stream",
  'name:"Stream"',
  "InferenceStream",
  "inferenceMessage",
  "InferenceMessage",
  "messages:{role",
];
for (const n of needles) {
  const hits = [];
  let from = 0;
  while (hits.length < 3) {
    const i = s.indexOf(n, from);
    if (i < 0) break;
    hits.push(s.slice(Math.max(0, i - 180), i + 400).replace(/\s+/g, " "));
    from = i + n.length;
  }
  console.log("**** needle", n, hits.length);
  for (const h of hits) console.log(" --", h.slice(0, 500));
}

// find method table for InferenceService
const svc = s.indexOf('typeName:"aiserver.v1.InferenceService"');
console.log("==== svc", svc);
if (svc >= 0) console.log(s.slice(svc, svc + 2500).replace(/\s+/g, " "));
const svc2 = s.indexOf("aiserver.v1.InferenceService");
console.log("==== svc2 first", svc2);
if (svc2 >= 0) console.log(s.slice(svc2, svc2 + 1800).replace(/\s+/g, " "));
