const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { buildInferenceTurn } = require("../src/inference-prompt");

describe("buildInferenceTurn", () => {
  it("injects no gateway system when the caller sent only a user turn", () => {
    const turn = buildInferenceTurn({
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    });
    assert.equal(turn.systemText, "");
    assert.equal(turn.userText, "Reply with exactly: pong");
    assert.equal(turn.rootMessages.length, 0);
  });

  it("passes the caller's system through as system, not a fake user/assistant exchange", () => {
    const turn = buildInferenceTurn({
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
      ],
    });
    assert.equal(turn.systemText, "Be terse.");
    assert.doesNotMatch(turn.systemText, /HARD RULE|CLIENT TOOLS|invoke_client_tool/);
    assert.equal(turn.rootMessages.length, 0);
    assert.equal(turn.userText, "hi");
  });

  it("does not invent a continuation user turn after tool results", () => {
    const turn = buildInferenceTurn({
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"Osaka"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: '{"temp_c":31}' },
      ],
    });
    assert.equal(turn.userText, "");
    assert.equal(turn.rootMessages[0].role, "user");
    assert.equal(turn.rootMessages[1].role, "assistant");
    assert.equal(turn.rootMessages[2].role, "tool");
  });
});
