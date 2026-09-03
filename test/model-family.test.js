const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildModelList,
  findModel,
} = require("../src/model-list");
const protocol = require("../src/openai-protocol");
const converter = require("../src/converter");
const { parseCatalog } = require("../src/model-catalog");
const {
  isSuffixPrimary,
  collapseIds,
  publishedRungs,
  resolveOpenAIModel,
  resolvePublicRequest,
  familyId,
  sandTextToolsOnly,
} = require("../src/model-family");

const USABLE = {
  models: [
    { modelId: "default", displayName: "Auto" },
    { modelId: "cursor-grok-4.6-low", displayName: "Cursor Grok 4.6 Low", aliases: ["grok-4.6-low"] },
    { modelId: "cursor-grok-4.6-high", displayName: "Cursor Grok 4.6 High" },
    { modelId: "kimi-k3-low", displayName: "Kimi K3 Low" },
    { modelId: "kimi-k3-max", displayName: "Kimi K3 Max", aliases: ["kimi-latest"] },
    { modelId: "claude-sonnet-5", displayName: "Claude Sonnet 5" },
    { modelId: "claude-sonnet-5-thinking-high", displayName: "Claude Sonnet 5 Thinking High" },
    { modelId: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
    { modelId: "claude-fable-5-1-thinking-low", displayName: "Claude Fable 5.1 Thinking Low" },
    { modelId: "claude-fable-5-1-thinking-max", displayName: "Claude Fable 5.1 Thinking Max" },
    { modelId: "claude-opus-5-thinking-high", displayName: "Claude Opus 5 Thinking High" },
    { modelId: "claude-4.5-sonnet", displayName: "Claude 4.5 Sonnet" },
    { modelId: "claude-4.5-sonnet-thinking-high", displayName: "Claude 4.5 Sonnet Thinking High" },
    { modelId: "claude-4.6-sonnet", displayName: "Claude 4.6 Sonnet" },
    { modelId: "claude-4.6-sonnet-medium-thinking", displayName: "Claude 4.6 Sonnet Medium Thinking" },
    { modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
    { modelId: "gpt-5.6-sol-none", displayName: "GPT-5.6 Sol None" },
    { modelId: "gpt-5.6-sol-none-fast", displayName: "GPT-5.6 Sol None Fast" },
    { modelId: "gemini-3.6-flash", displayName: "Gemini 3.6 Flash" },
    { modelId: "gemini-3.6-flash-minimal", displayName: "Gemini 3.6 Flash Minimal" },
    { modelId: "composer-2.5-fast", displayName: "Composer 2.5 Fast" },
  ],
};

const CATALOG = parseCatalog({
  models: [
    {
      name: "kimi-k3",
      parameterDefinitions: [
        {
          id: "reasoning",
          parameterType: {
            enumParameter: {
              values: [{ value: "low" }, { value: "high" }, { value: "max" }],
            },
          },
        },
      ],
      variants: [
        { parameterValues: [{ id: "reasoning", value: "low" }], legacySlug: "kimi-k3-low" },
        {
          parameterValues: [{ id: "reasoning", value: "max" }],
          legacySlug: "kimi-k3-max",
          isDefaultNonMaxConfig: true,
        },
      ],
    },
  ],
});

const CREATED = 1756500000;
const LIST = buildModelList(USABLE, null, CREATED);
const USABLE_IDS = USABLE.models.map((m) => m.modelId).filter((id) => id && id !== "default");

function resolveLikeServer(requested, body) {
  const invalid = protocol.validateChatRequest({
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    ...body,
    model: requested,
  });
  if (invalid) return { status: 400, json: invalid, upstream: false };
  const resolved = resolvePublicRequest(requested, body, {
    usable: USABLE_IDS,
    catalog: CATALOG,
    mapModel: converter.mapModel,
  });
  if (resolved.error) return { status: 400, json: resolved.error, upstream: false };
  return { status: 200, resolved, upstream: false };
}

describe("advertised ids collapse to families", () => {
  it("does not list thinking or effort suffix slugs as primary ids", () => {
    const ids = LIST.data.map((m) => m.id);
    assert.deepEqual(ids, collapseIds(USABLE_IDS));
    for (const id of ids) assert.equal(isSuffixPrimary(id), false);
    assert.ok(ids.includes("kimi-k3"));
    assert.ok(ids.includes("grok-4.6"));
    assert.ok(ids.includes("claude-sonnet-5"));
    assert.ok(ids.includes("claude-fable-5-1"));
    assert.equal(ids.includes("kimi-k3-max"), false);
    assert.equal(ids.includes("cursor-grok-4.6-low"), false);
    assert.equal(ids.includes("claude-sonnet-5-thinking-high"), false);
    assert.equal(ids.includes("claude-4.6-sonnet-medium-thinking"), false);
    assert.equal(ids.includes("gpt-5.6-sol-none"), false);
    assert.equal(ids.includes("gpt-5.6-sol-none-fast"), false);
    assert.equal(ids.includes("gemini-3.6-flash-minimal"), false);
    assert.ok(ids.includes("claude-4.6-sonnet"));
    assert.ok(ids.includes("gpt-5.6-sol"));
    assert.ok(ids.includes("gemini-3.6-flash"));
  });

  it("still resolves a suffix slug or dotted alias to the family row", () => {
    assert.equal(findModel("kimi-k3-max", LIST).id, "kimi-k3");
    assert.equal(findModel("claude-fable-5.1", LIST).id, "claude-fable-5-1");
    assert.equal(findModel("claude-fable", LIST).id, "claude-fable-5-1");
    assert.equal(findModel("claude-sonnet-4.5", LIST).id, "claude-4.5-sonnet");
  });
});

describe("sandTextToolsOnly", () => {
  it("is on for Claude families and off for kimi", () => {
    assert.equal(sandTextToolsOnly("claude-sonnet-5"), true);
    assert.equal(sandTextToolsOnly("claude-sonnet-5-thinking-high"), true);
    assert.equal(sandTextToolsOnly("claude-4.5-sonnet"), true);
    assert.equal(sandTextToolsOnly("kimi-k3-max"), false);
    assert.equal(sandTextToolsOnly("grok-4.6"), false);
  });
});

describe("thinking-control validation", () => {
  it("returns the OpenAI 400 envelope listing supported rungs", () => {
    const got = resolveLikeServer("kimi-k3", { reasoning_effort: "medium" });
    assert.equal(got.status, 400);
    assert.equal(got.upstream, false);
    const err = got.json.error;
    assert.equal(err.type, "invalid_request_error");
    assert.equal(err.param, "reasoning_effort");
    assert.equal(err.code, "invalid_value");
    assert.match(err.message, /Invalid value: 'medium' for 'reasoning_effort'/);
    assert.match(err.message, /'low'/);
    assert.match(err.message, /'high'/);
    assert.match(err.message, /'max'/);
    assert.equal(/'medium'/.test(err.message.split("Supported values")[1] || ""), false);
  });

  it("names reasoning.effort when that is the field the client sent", () => {
    const resolved = resolvePublicRequest(
      "kimi-k3",
      { reasoning: { effort: "turbo" } },
      { usable: USABLE_IDS, catalog: CATALOG }
    );
    assert.equal(resolved.error.error.param, "reasoning.effort");
    assert.match(resolved.error.error.message, /'turbo'/);
    assert.match(resolved.error.error.message, /Supported values/);
  });

  it("names thinking.effort when that is the field the client sent", () => {
    const resolved = resolvePublicRequest(
      "claude-sonnet-5",
      { thinking: { effort: "turbo" } },
      { usable: USABLE_IDS }
    );
    assert.equal(resolved.error.error.param, "thinking.effort");
    assert.match(resolved.error.error.message, /Supported values/);
  });

  it("rejects thinking-control on a model that publishes no rungs", () => {
    const resolved = resolvePublicRequest(
      "composer-2.5-fast",
      { reasoning_effort: "high" },
      { usable: USABLE_IDS }
    );
    assert.equal(resolved.error.error.code, "invalid_value");
    assert.match(resolved.error.error.message, /Supported values: \(none\)/);
    const none = resolvePublicRequest(
      "composer-2.5-fast",
      { reasoning_effort: "none" },
      { usable: USABLE_IDS }
    );
    assert.equal(none.error.error.code, "invalid_value");
  });
});

describe("latest Claude ids and omitted vs none vs a rung", () => {
  it("maps dotted and bare latest ids onto a catalog-runnable slug", () => {
    assert.equal(familyId("claude-fable-5.1"), "claude-fable-5-1");
    assert.equal(familyId("claude-sonnet-4.5"), "claude-4.5-sonnet");
    assert.equal(familyId("claude-opus-5"), "claude-opus-5");
    const fable = resolvePublicRequest("claude-fable-5.1", {}, { usable: USABLE_IDS });
    assert.equal(fable.modelId, "claude-fable-5-1");
    const short = resolvePublicRequest("claude-fable", {}, { usable: USABLE_IDS, mapModel: converter.mapModel });
    assert.equal(short.family, "claude-fable-5-1");
    assert.equal(short.modelId, "claude-fable-5-1");
    const sonnet = resolvePublicRequest("claude-sonnet-4.5", {}, { usable: USABLE_IDS });
    assert.equal(sonnet.modelId, "claude-4.5-sonnet");
    const opus = resolvePublicRequest("claude-opus-5", {}, { usable: USABLE_IDS });
    assert.equal(opus.modelId, "claude-opus-5-thinking-high");
  });

  it("does not imply thinking-max when effort is omitted", () => {
    const fable = resolveOpenAIModel("claude-fable-5.1", {}, { usable: USABLE_IDS });
    assert.equal(fable.slug, "claude-fable-5-1");
    assert.equal(String(fable.slug).includes("thinking-max"), false);
    const kimi = resolvePublicRequest("kimi-k3", {}, { usable: USABLE_IDS, catalog: CATALOG });
    assert.equal(kimi.modelId, "kimi-k3-max");
  });

  it("prefers a -fast twin of the default slug when that slug exists", () => {
    const usable = [...USABLE_IDS, "claude-fable-5-1-fast"];
    const fable = resolveOpenAIModel("claude-fable-5.1", {}, { usable });
    assert.equal(fable.slug, "claude-fable-5-1-fast");
    assert.equal(fable.fast, true);
    const max = resolveOpenAIModel(
      "claude-fable-5.1",
      { reasoning_effort: "max" },
      { usable: [...usable, "claude-fable-5-1-thinking-max-fast"] }
    );
    assert.equal(max.slug, "claude-fable-5-1-thinking-max-fast");
  });

  it("maps none onto a non-thinking slug and a listed rung onto thinking", () => {
    const none = resolvePublicRequest("claude-fable-5.1", { reasoning_effort: "none" }, { usable: USABLE_IDS });
    assert.equal(none.modelId, "claude-fable-5-1");
    assert.equal(none.effort, "none");
    const max = resolvePublicRequest("claude-fable-5.1", { reasoning_effort: "max" }, { usable: USABLE_IDS });
    assert.equal(max.modelId, "claude-fable-5-1-thinking-max");
    assert.equal(max.effort, "max");
  });

  it("rejects none when the family has no non-thinking slug", () => {
    const got = resolveLikeServer("kimi-k3", { reasoning_effort: "none" });
    assert.equal(got.status, 400);
    assert.match(got.json.error.message, /'none'/);
  });
});

describe("request path rejects bad effort before upstream", () => {
  it("stops at the OpenAI 400 and never marks an upstream call", () => {
    const chat = resolveLikeServer("claude-opus-5", { reasoning_effort: "turbo" });
    assert.equal(chat.status, 400);
    assert.equal(chat.upstream, false);
    assert.equal(chat.json.error.type, "invalid_request_error");
    assert.match(chat.json.error.message, /Supported values/);
    const responses = resolvePublicRequest(
      "claude-opus-5",
      { reasoning: { effort: "turbo" } },
      { usable: USABLE_IDS }
    );
    assert.equal(responses.error.error.param, "reasoning.effort");
  });

  it("echoes the caller-requested model by leaving resolve to return the internal slug only", () => {
    const got = resolveLikeServer("claude-fable-5.1", { reasoning_effort: "low" });
    assert.equal(got.status, 200);
    assert.equal(got.resolved.modelId, "claude-fable-5-1-thinking-low");
    assert.equal(got.resolved.family, "claude-fable-5-1");
  });
});

describe("old thinking-suffix aliases", () => {
  it("still honors thinking-max and inverted names when no effort param is sent", () => {
    const max = resolvePublicRequest("claude-fable-5-1-thinking-max", {}, { usable: USABLE_IDS });
    assert.equal(max.modelId, "claude-fable-5-1-thinking-max");
    assert.equal(max.effort, "max");
    const inverted = resolvePublicRequest("claude-4.6-sonnet-medium-thinking", {}, { usable: USABLE_IDS });
    assert.equal(inverted.modelId, "claude-4.6-sonnet-medium-thinking");
    assert.equal(inverted.effort, "medium");
    const kimiMax = resolvePublicRequest("kimi-k3-max", {}, { usable: USABLE_IDS, catalog: CATALOG, mapModel: converter.mapModel });
    assert.equal(kimiMax.modelId, "kimi-k3-max");
    const kimiLow = resolvePublicRequest("kimi-k3-low", {}, { usable: USABLE_IDS, catalog: CATALOG, mapModel: converter.mapModel });
    assert.equal(kimiLow.modelId, "kimi-k3-low");
  });

  it("does not pick a non-thinking -high slug when a thinking sibling exists", () => {
    const high = resolvePublicRequest("claude-sonnet-5", { reasoning_effort: "high" }, { usable: USABLE_IDS });
    assert.equal(high.modelId, "claude-sonnet-5-thinking-high");
    const alias = resolvePublicRequest(
      "claude-sonnet-5-thinking-high",
      { reasoning_effort: "high" },
      { usable: USABLE_IDS }
    );
    assert.equal(alias.modelId, "claude-sonnet-5-thinking-high");
  });

  it("lets reasoning_effort override the alias suffix", () => {
    const low = resolvePublicRequest(
      "claude-fable-5-1-thinking-max",
      { reasoning_effort: "low" },
      { usable: USABLE_IDS }
    );
    assert.equal(low.modelId, "claude-fable-5-1-thinking-low");
    assert.equal(low.effort, "low");
    const kimi = resolvePublicRequest(
      "kimi-k3-max",
      { reasoning_effort: "low" },
      { usable: USABLE_IDS, catalog: CATALOG, mapModel: converter.mapModel }
    );
    assert.equal(kimi.modelId, "kimi-k3-low");
    const none = resolvePublicRequest(
      "claude-fable-5-1-thinking-max",
      { reasoning: { effort: "none" } },
      { usable: USABLE_IDS }
    );
    assert.equal(none.modelId, "claude-fable-5-1");
    assert.equal(none.effort, "none");
  });

  it("still honours an explicit none instead of forcing max", () => {
    const fable = resolvePublicRequest(
      "claude-fable-5.1",
      { reasoning_effort: "none" },
      { usable: USABLE_IDS, mapModel: converter.mapModel }
    );
    assert.equal(fable.modelId, "claude-fable-5-1");
    assert.equal(fable.effort, "none");
  });
});

describe("published rungs from slug patterns", () => {
  it("lists none when a non-thinking slug exists", () => {
    assert.deepEqual(publishedRungs("claude-fable-5-1", USABLE_IDS), ["none", "low", "max"]);
  });

  it("routes inverted Claude thinking slugs and gpt -none onto the family", () => {
    assert.equal(familyId("claude-4.6-sonnet-medium-thinking"), "claude-4.6-sonnet");
    assert.equal(familyId("claude-4.5-sonnet-thinking"), "claude-4.5-sonnet");
    assert.equal(familyId("gpt-5.6-sol-none-fast"), "gpt-5.6-sol");
    const none = resolvePublicRequest("gpt-5.6-sol", { reasoning_effort: "none" }, { usable: USABLE_IDS });
    assert.equal(none.modelId, "gpt-5.6-sol-none-fast");
    const omitted = resolvePublicRequest("gpt-5.6-sol", {}, { usable: USABLE_IDS });
    assert.equal(omitted.modelId, "gpt-5.6-sol");
    const high = resolvePublicRequest("gpt-5.6-sol", { reasoning_effort: "high" }, { usable: USABLE_IDS });
    assert.equal(high.error.error.code, "invalid_value");
    assert.match(high.error.error.message, /'none'/);
    const min = resolvePublicRequest("gemini-3.6-flash", { reasoning_effort: "minimal" }, { usable: USABLE_IDS });
    assert.equal(min.modelId, "gemini-3.6-flash-minimal");
  });
});
