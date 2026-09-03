const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseCatalog, resolveModel, catalogRequestBody } = require("../src/model-catalog");

// Trimmed from the live response on 2026-08-30, keeping the exact nesting the
// server uses so the parser is checked against real shapes.
const LIVE = {
  models: [
    { name: "default" },
    {
      name: "kimi-k3",
      serverModelName: "kimi-k3",
      supportsThinking: true,
      parameterDefinitions: [
        {
          id: "reasoning",
          name: "Reasoning",
          parameterType: {
            enumParameter: {
              values: [
                { value: "low", displayName: "Low" },
                { value: "high", displayName: "High" },
                { value: "max", displayName: "Max" },
              ],
            },
          },
        },
      ],
      variants: [
        { parameterValues: [{ id: "reasoning", value: "low" }], legacySlug: "kimi-k3-low" },
        { parameterValues: [{ id: "reasoning", value: "high" }], legacySlug: "kimi-k3-high" },
        {
          parameterValues: [{ id: "reasoning", value: "max" }],
          legacySlug: "kimi-k3-max",
          isDefaultNonMaxConfig: true,
        },
      ],
      legacySlugs: ["kimi-k3-low", "kimi-k3-high", "kimi-k3-max"],
    },
    {
      name: "grok-4.6",
      parameterDefinitions: [
        {
          id: "effort",
          parameterType: {
            enumParameter: {
              values: [
                { value: "low" },
                { value: "medium" },
                { value: "high" },
                { value: "xhigh" },
              ],
            },
          },
        },
        {
          id: "fast",
          parameterType: { booleanParameter: { values: [{ value: "false" }, { value: "true" }] } },
        },
      ],
    },
    {
      name: "kimi-k2.7-code",
      variants: [{ legacySlug: "kimi-k2.7-code" }],
      idAliases: ["kimi-latest", "kimi"],
    },
  ],
};

const TABLE = parseCatalog(LIVE);

describe("catalog request", () => {
  it("asks for the parameter definitions, which are off by default", () => {
    assert.equal(catalogRequestBody().useModelParameters, true);
  });
});

describe("parsing the live shape", () => {
  it("reads enum values out of parameterType.enumParameter", () => {
    assert.deepEqual(TABLE["kimi-k3"].params.reasoning, ["low", "high", "max"]);
    assert.deepEqual(TABLE["grok-4.6"].params.effort, ["low", "medium", "high", "xhigh"]);
  });

  it("reads boolean values out of parameterType.booleanParameter", () => {
    assert.deepEqual(TABLE["grok-4.6"].params.fast, ["false", "true"]);
  });

  it("keeps each variant with the parameters its slug stands for", () => {
    assert.deepEqual(TABLE["kimi-k3"].variants, [
      { slug: "kimi-k3-low", isDefault: false, params: { reasoning: "low" } },
      { slug: "kimi-k3-high", isDefault: false, params: { reasoning: "high" } },
      { slug: "kimi-k3-max", isDefault: true, params: { reasoning: "max" } },
    ]);
  });
});

// The transport rejects base ids and ignores requestedModel.parameters, so the
// only lever is picking the variant slug that stands for the depth asked for.
describe("resolveModel", () => {
  it("leaves a slug alone when no depth was requested", () => {
    assert.deepEqual(resolveModel("kimi-k3-max", {}, TABLE), {
      modelId: "kimi-k3-max",
      effort: null,
    });
  });

  it("switches to the slug that carries the requested depth", () => {
    assert.deepEqual(resolveModel("kimi-k3-max", { reasoning_effort: "low" }, TABLE), {
      modelId: "kimi-k3-low",
      effort: "low",
    });
    assert.deepEqual(resolveModel("kimi-k3-low", { reasoning_effort: "max" }, TABLE), {
      modelId: "kimi-k3-max",
      effort: "max",
    });
  });

  it("routes a bare base id to its default variant, which is what runs", () => {
    assert.deepEqual(resolveModel("kimi-k3", {}, TABLE), {
      modelId: "kimi-k3-max",
      effort: null,
    });
  });

  it("reads depth from whichever parameter the family publishes", () => {
    assert.equal(resolveModel("kimi-k3-low", { reasoning_effort: "high" }, TABLE).modelId, "kimi-k3-high");
    // grok publishes effort, but this catalog entry has no variants to name,
    // so there is nothing safe to switch to.
    assert.equal(resolveModel("grok-4.6", { reasoning_effort: "high" }, TABLE).effort, null);
  });

  it("clamps a depth the model does not publish", () => {
    // kimi has no medium rung; low and high are equidistant so it takes the
    // stronger one.
    assert.deepEqual(resolveModel("kimi-k3-low", { reasoning_effort: "medium" }, TABLE), {
      modelId: "kimi-k3-high",
      effort: "high",
    });
  });

  it("accepts the Anthropic spelling of the same intent", () => {
    assert.equal(
      resolveModel("kimi-k3-max", { thinking: { budget_tokens: 512 } }, TABLE).modelId,
      "kimi-k3-low"
    );
  });

  it("resolves an alias to its base model", () => {
    assert.equal(resolveModel("kimi-latest", {}, TABLE).modelId, "kimi-k2.7-code");
  });

  it("leaves a model that publishes no depth alone", () => {
    assert.deepEqual(resolveModel("kimi-k2.7-code", { reasoning_effort: "max" }, TABLE), {
      modelId: "kimi-k2.7-code",
      effort: null,
    });
  });

  it("passes an unknown model through untouched", () => {
    assert.deepEqual(resolveModel("something-else", { reasoning_effort: "high" }, TABLE), {
      modelId: "something-else",
      effort: null,
    });
  });

  it("never names a variant whose value the model did not publish", () => {
    const table = parseCatalog({
      models: [
        {
          name: "m",
          parameterDefinitions: [
            { id: "effort", parameterType: { enumParameter: { values: [{ value: "low" }] } } },
          ],
          variants: [
            { parameterValues: [{ id: "effort", value: "low" }], legacySlug: "m-low" },
            { parameterValues: [{ id: "effort", value: "ultra" }], legacySlug: "m-ultra" },
          ],
        },
      ],
    });
    assert.equal(resolveModel("m-low", { reasoning_effort: "max" }, table).modelId, "m-low");
  });

  it("survives an empty catalog", () => {
    assert.deepEqual(resolveModel("kimi-k3-max", { reasoning_effort: "max" }, {}), {
      modelId: "kimi-k3-max",
      effort: null,
    });
  });
});
