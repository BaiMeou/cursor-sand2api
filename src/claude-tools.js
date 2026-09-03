// Claude on sand 429s / 502s as soon as proto `tools` is present, including
// with customToolFormat. Always keep OpenAI tools as prompt XML + parse.

const { sandTextToolsOnly } = require("./model-family");

const CUSTOM_TOOL_FORMAT = {
  type: "text",
  syntax: "xml",
  definition:
    'Call tools with Anthropic XML: <function_calls><invoke name="NAME"><parameter name="KEY">VALUE</parameter></invoke></function_calls>',
};

function claudeOnSand(modelId) {
  return sandTextToolsOnly(modelId);
}

function claudeNeedsTextTools(modelId) {
  return claudeOnSand(modelId);
}

function claudeTryCustomFormat() {
  return false;
}

function markClaudeXmlFallback() {}

function isClaudeToolsNativeFailure() {
  return false;
}

function resetXmlFallback() {}

module.exports = {
  CUSTOM_TOOL_FORMAT,
  claudeOnSand,
  claudeNeedsTextTools,
  claudeTryCustomFormat,
  markClaudeXmlFallback,
  isClaudeToolsNativeFailure,
  resetXmlFallback,
};
