#!/usr/bin/env node
const fs = require("fs");
const { workbenchPath } = require("./cursor-workbench");
const s = fs.readFileSync(workbenchPath(), "utf8");

function around(needle, before = 400, after = 1200) {
  const hits = [];
  let from = 0;
  while (hits.length < 8) {
    const i = s.indexOf(needle, from);
    if (i < 0) break;
    hits.push({
      at: i,
      snippet: s.slice(Math.max(0, i - before), i + after),
    });
    from = i + needle.length;
  }
  return hits;
}

const needles = [
  "StreamGenerate",
  "streamGenerate",
  "GenerateRequest",
  "StreamGenerateRequest",
  "name:\"StreamGenerate\"",
  "StreamEdit",
];

const out = {};
for (const n of needles) {
  const hits = around(n, 200, 800);
  out[n] = hits.map((h) => h.snippet.replace(/\s+/g, " ").slice(0, 900));
}

// connect-es method table near StreamGenerate
function typeBlock(typeName) {
  const needle = `makeMessageType("${typeName}"`;
  const i = s.indexOf(needle);
  if (i < 0) return null;
  return s.slice(i, i + 2500).replace(/\s+/g, " ");
}

out.streamGenerateRequest = typeBlock("aiserver.v1.StreamGenerateRequest");
out.streamEditRequest = typeBlock("aiserver.v1.StreamEditRequest");
out.streamChatToolformer = typeBlock("aiserver.v1.StreamChatToolformerRequest")
  || typeBlock("aiserver.v1.GetChatRequest");
out.responseAae = (() => {
  // StreamGenerate output type aAe — find nearby makeMessageType used as O
  const i = s.indexOf('makeMessageType("aiserver.v1.StreamGenerateResponse"');
  if (i >= 0) return s.slice(i, i + 1800).replace(/\s+/g, " ");
  const j = s.indexOf('makeMessageType("aiserver.v1.StreamCmdKResponse"');
  if (j >= 0) return s.slice(j, j + 1800).replace(/\s+/g, " ");
  const k = s.indexOf('makeMessageType("aiserver.v1.StreamChatResponse"');
  if (k >= 0) return s.slice(k, k + 1800).replace(/\s+/g, " ");
  return null;
})();

const chatResp = [
  "aiserver.v1.StreamGenerateResponse",
  "aiserver.v1.StreamChatResponse",
  "aiserver.v1.StreamCmdKResponse",
  "aiserver.v1.EditFileResponse",
  "aiserver.v1.StreamedBackText",
];
out.responses = {};
for (const t of chatResp) out.responses[t] = typeBlock(t);

fs.writeFileSync(
  require("path").join(__dirname, "stream-generate-extract.json"),
  JSON.stringify(out, null, 2)
);
console.log(JSON.stringify({
  streamGenerateHits: (out.StreamGenerate || []).length,
  methodTable: out.methodTable,
  editTable: out.editTable,
  first: (out.StreamGenerate || [])[0],
}, null, 2));
