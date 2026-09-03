#!/usr/bin/env node
const fs = require("fs");
const { workbenchPath } = require("./cursor-workbench");
const s = fs.readFileSync(workbenchPath(), "utf8");

function around(needle, n = 2800) {
  const i = s.indexOf(needle);
  if (i < 0) return { i, text: null };
  return { i, text: s.slice(i, i + n).replace(/\s+/g, " ") };
}

const needles = [
  'makeMessageType("aiserver.v1.InferenceCoreMessage"',
  'makeMessageType("aiserver.v1.InferenceContentPart"',
  'makeMessageType("aiserver.v1.InferenceImagePart"',
  'makeMessageType("aiserver.v1.InferenceFilePart"',
  'makeMessageType("aiserver.v1.InferenceTextPart"',
  'makeMessageType("aiserver.v1.InferenceToolContent"',
  'makeMessageType("aiserver.v1.InferenceToolCall"',
  'makeMessageType("aiserver.v1.InferenceAgentTool"',
  'makeMessageType("aiserver.v1.InferenceModelConfig"',
  'makeMessageType("aiserver.v1.InferenceRequestedModel"',
];

for (const n of needles) {
  const b = around(n, 3200);
  console.log("====", n, b.i);
  if (b.text) console.log(b.text.slice(0, 2800));
}

// parts type is T:rvv next to InferenceCoreMessage
const core = s.indexOf('makeMessageType("aiserver.v1.InferenceCoreMessage"');
if (core >= 0) {
  const slice = s.slice(core, core + 6000);
  const m = slice.match(/name:"parts",kind:"message",T:([A-Za-z0-9$]+)/);
  console.log("==== parts T", m && m[1]);
  if (m) {
    const decl = s.indexOf(`${m[1]}=A.makeMessageType(`);
    console.log("==== parts decl", decl);
    if (decl >= 0) console.log(s.slice(decl, decl + 2500).replace(/\s+/g, " "));
  }
}

for (const n of [
  "InferenceContentPart",
  "image_part",
  "imagePart",
  "file_part",
  "media_part",
  "data_part",
  "inline_data",
  "inlineData",
]) {
  const i = s.indexOf(n);
  console.log("****", n, i);
  if (i >= 0) console.log(s.slice(Math.max(0, i - 80), i + 500).replace(/\s+/g, " "));
}
