const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { officialSelection, parseRequestedModel, prefixOfficialUsable, applyEffortToSandId } = require("../src/model-route");

describe("official model selection", () => {
  it("maps kimi-k3-max onto the official base id plus reasoning=max", () => {
    assert.deepEqual(officialSelection("kimi-k3-max"), {
      id: "kimi-k3",
      params: [{ id: "reasoning", value: "max" }],
    });
  });

  it("keeps kimi-k3-low as reasoning=low", () => {
    assert.equal(officialSelection("kimi-k3-low").params[0].value, "low");
  });

  it("maps sand grok variant names onto grok-4.6 + effort", () => {
    assert.deepEqual(officialSelection("cursor-grok-4.6-high"), {
      id: "grok-4.6",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
  });

  it("strips -fast into the fast parameter", () => {
    const sel = officialSelection("cursor-grok-4.6-high-fast");
    assert.equal(sel.id, "grok-4.6");
    assert.equal(sel.params.find((p) => p.id === "fast").value, "true");
  });

  it("strips the api- prefix before selecting", () => {
    assert.equal(officialSelection("api-kimi-k3-max").id, "kimi-k3");
    assert.equal(officialSelection("api-kimi-k3-max").params[0].value, "max");
  });

  it("lets reasoning_effort override the model suffix", () => {
    assert.equal(officialSelection("api-kimi-k3-max", "low").params[0].value, "low");
    assert.equal(officialSelection("grok-4.6", "max").params.find((p) => p.id === "effort").value, "xhigh");
  });

  it("prefixes official catalog names without duplicating variants as extra ids", () => {
    const out = prefixOfficialUsable({ models: [{ name: "kimi-k3", displayName: "Kimi K3" }] });
    const ids = out.models.map((m) => m.name);
    assert.deepEqual(ids, ["api-kimi-k3"]);
    assert.ok(out.models[0].aliases.includes("api-kimi-k3-max"));
  });

  it("flags api- models as official", () => {
    assert.equal(parseRequestedModel("api-composer-2.5").official, true);
    assert.equal(parseRequestedModel("api-composer-2.5").rest, "composer-2.5");
    assert.equal(parseRequestedModel("kimi-k3-max").official, false);
  });

  it("maps sand kimi ids from reasoning effort", () => {
    assert.equal(applyEffortToSandId("kimi-k3-max", "low"), "kimi-k3-low");
    assert.equal(applyEffortToSandId("kimi-k3-low", "max"), "kimi-k3-max");
  });

  it("maps dotted claude-fable-5.1 onto fast when effort is omitted", () => {
    assert.equal(applyEffortToSandId("claude-fable-5.1"), "claude-fable-5-1-fast");
    assert.equal(applyEffortToSandId("claude-fable-5-1"), "claude-fable-5-1-fast");
    assert.equal(applyEffortToSandId("claude-fable-5.1", "low"), "claude-fable-5-1-thinking-low-fast");
    assert.equal(applyEffortToSandId("claude-fable-5-1-high"), "claude-fable-5-1-high");
    assert.equal(applyEffortToSandId("claude-fable-5-1-thinking-max"), "claude-fable-5-1-thinking-max");
    assert.equal(applyEffortToSandId("claude-fable-5-1-thinking-low", "max"), "claude-fable-5-1-thinking-max-fast");
    assert.equal(applyEffortToSandId("claude-fable-5.1", "none"), "claude-fable-5-1-fast");
  });
});
