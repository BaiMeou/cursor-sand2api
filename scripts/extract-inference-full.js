#!/usr/bin/env node
const fs = require("fs");
const { workbenchPath } = require("./cursor-workbench");
const s = fs.readFileSync(workbenchPath(), "utf8");

function block(name, n = 4000) {
  const needle = `makeMessageType("${name}"`;
  const i = s.indexOf(needle);
  if (i < 0) return { name, i, text: null };
  return { name, i, text: s.slice(i, i + n).replace(/\s+/g, " ") };
}

const names = [
  "aiserver.v1.InferenceStreamRequest",
  "aiserver.v1.InferenceStreamResponse",
  "aiserver.v1.InferenceCoreMessage",
  "aiserver.v1.InferenceContentParts",
  "aiserver.v1.InferenceContentPart",
  "aiserver.v1.InferenceTextPart",
  "aiserver.v1.InferenceImagePart",
  "aiserver.v1.InferenceFilePart",
  "aiserver.v1.InferenceToolCall",
  "aiserver.v1.InferenceToolContent",
  "aiserver.v1.InferenceToolResultPart",
  "aiserver.v1.InferenceAgentTool",
  "aiserver.v1.InferenceCustomToolFormat",
  "aiserver.v1.InferenceNamedProviderDefinedTool",
  "aiserver.v1.InferenceModelConfig",
  "aiserver.v1.InferenceRequestedModel",
  "aiserver.v1.InferenceModelParameterValue",
  "aiserver.v1.InferenceReasoningPart",
  "aiserver.v1.InferenceTextStreamPart",
  "aiserver.v1.InferenceThinkingStreamPart",
  "aiserver.v1.InferenceToolCallStreamPart",
  "aiserver.v1.InferenceUsageInfo",
  "aiserver.v1.InferenceExtendedUsageInfo",
  "aiserver.v1.InferenceResponseInfo",
  "aiserver.v1.InferenceImageDescriptionsInfo",
  "aiserver.v1.InferenceImageDescription",
  "aiserver.v1.InferenceProviderMetadata",
  "aiserver.v1.InferenceInvocationId",
  "aiserver.v1.InferenceStreamError",
];

for (const n of names) {
  const b = block(n, 1800);
  console.log("====", n, b.i);
  if (b.text) console.log(b.text.slice(0, 1600));
}

const enums = [
  "aiserver.v1.InferenceMessageRole",
  "aiserver.v1.InferenceStreamErrorType",
  "aiserver.v1.InferenceReason",
];
for (const n of enums) {
  const i = s.indexOf(`makeEnum("${n}"`);
  console.log("==== ENUM", n, i);
  if (i >= 0) console.log(s.slice(i, i + 900).replace(/\s+/g, " "));
}
