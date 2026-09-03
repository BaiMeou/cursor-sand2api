const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  claudeOnSand,
  claudeTryCustomFormat,
  claudeNeedsTextTools,
  CUSTOM_TOOL_FORMAT,
} = require("../src/claude-tools");
const { buildHeaders } = require("../src/cursor-client");
const config = require("../src/config");

describe("claude tool transport", () => {
  it("defaults sand Claude onto prompt XML, never proto tools", () => {
    assert.equal(claudeOnSand("claude-fable-5-1-thinking-max-fast"), true);
    assert.equal(claudeTryCustomFormat("claude-fable-5-1-thinking-max-fast"), false);
    assert.equal(claudeNeedsTextTools("claude-fable-5-1-thinking-max-fast"), true);
    assert.equal(claudeNeedsTextTools("claude-sonnet-5"), true);
    assert.equal(CUSTOM_TOOL_FORMAT.syntax, "xml");
  });

  it("does not rewrite Kimi onto the text-tool path", () => {
    assert.equal(claudeOnSand("kimi-k3-max"), false);
    assert.equal(claudeTryCustomFormat("kimi-k3-max"), false);
    assert.equal(claudeNeedsTextTools("kimi-k3-max"), false);
  });

  it("keeps the allowed-tools header on Claude XML turns", () => {
    const prev = config.cursor.allowedNativeTools;
    config.cursor.allowedNativeTools = ["mcp_tool_call", "get_mcp_tools_tool_call"];
    try {
      const token = { accessToken: "t", machineId: "m", macMachineId: "n" };
      const path = "/aiserver.v1.InferenceService/Stream";
      const keep = buildHeaders(token, path);
      const omit = buildHeaders(token, path, { omitAllowedTools: true });
      assert.equal(keep["x-cursor-agent-allowed-tools"], "mcp_tool_call,get_mcp_tools_tool_call");
      assert.equal(omit["x-cursor-agent-allowed-tools"], undefined);
    } finally {
      config.cursor.allowedNativeTools = prev;
    }
  });
});
