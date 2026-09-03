const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  buildModelList,
  buildModelObject,
  findModel,
  parseContextWindow,
  createModelList,
} = require("../src/model-list");

// Trimmed from the live responses on 2026-08-30, field for field, so the join is
// checked against the shapes the two RPCs really send.

// agent.v1.AgentService/GetUsableModels, body {} — the names that actually run.
const USABLE = {
  models: [
    { modelId: "default", displayModelId: "default", displayName: "Auto" },
    {
      modelId: "cursor-grok-4.6-low",
      displayModelId: "cursor-grok-4.6",
      displayName: "Cursor Grok 4.6 Low",
      displayNameShort: "Grok 4.6 Low",
      aliases: [],
      maxMode: false,
    },
    {
      modelId: "kimi-k3-max",
      displayModelId: "kimi-k3",
      displayName: "Kimi K3 Max",
      displayNameShort: "K3 Max",
      aliases: ["kimi-latest"],
      maxMode: false,
    },
    {
      modelId: "claude-sonnet-5-thinking-high",
      displayModelId: "claude-sonnet-5-thinking",
      displayName: "Claude Sonnet 5 Thinking High",
      maxMode: true,
    },
    // Runnable, but the catalog half never mentions it.
    { modelId: "composer-2.5-fast", displayName: "Composer 2.5 Fast" },
  ],
};

// aiserver.v1.AiService/AvailableModels, body {} — 207 names with capability
// flags and prose, and no parameter definitions.
const CATALOG = {
  models: [
    { name: "default" },
    {
      name: "cursor-grok-4.6-low",
      defaultOn: true,
      supportsAgent: true,
      degradationStatus: "DEGRADATION_STATUS_UNSPECIFIED",
      tooltipData: {
        markdownContent:
          "**Cursor Grok 4.6**<br />Cursor's tuned Grok<br /><br />256k context window<br /><br />*Version: low effort*",
      },
      supportsThinking: true,
      supportsImages: false,
      supportsMaxMode: true,
      clientDisplayName: "Cursor Grok 4.6 Low",
      serverModelName: "cursor-grok-4.6-low",
      supportsNonMaxMode: true,
      tooltipDataForMaxMode: { markdownContent: "**Cursor Grok 4.6**<br /><br />1M context window" },
      isRecommendedForBackgroundComposer: false,
      supportsPlanMode: true,
      inputboxShortModelName: "grok-4.6-low",
      supportsSandboxing: true,
      idAliases: ["grok-4.6-low"],
    },
    {
      // No supportsImages key at all: proto3 JSON drops a false, and kimi is one
      // of the 22 of 207 that cannot see images.
      name: "kimi-k3-max",
      defaultOn: true,
      supportsAgent: true,
      supportsThinking: true,
      supportsMaxMode: true,
      clientDisplayName: "Kimi K3 Max",
      serverModelName: "kimi-k3-max",
      tooltipData: {
        markdownContent: "**Kimi K3**<br /><br />256000 context window<br /><br />*Version: max*",
      },
      idAliases: ["kimi-k3-latest"],
    },
    {
      name: "claude-sonnet-5-thinking-high",
      supportsAgent: true,
      supportsImages: true,
      supportsThinking: true,
      supportsMaxMode: true,
      clientDisplayName: "Claude Sonnet 5 Thinking High",
      contextTokenLimit: 200000,
      contextTokenLimitForMaxMode: 1000000,
      vendorName: "Anthropic",
      // The prose quotes the max-mode window; the number is the one that counts.
      tooltipData: { markdownContent: "**Claude Sonnet 5**<br /><br />1M context window" },
    },
    {
      // Known to the catalog, absent from the runnable list, and its window is
      // stated in a unit this parser refuses to guess at.
      name: "cursor-grok-4.6-high",
      supportsAgent: true,
      supportsImages: false,
      clientDisplayName: "Cursor Grok 4.6 High",
      tooltipData: { markdownContent: "**Cursor Grok 4.6**<br /><br />1M context window" },
    },
  ],
};

const CREATED = 1756500000;
const LIST = buildModelList(USABLE, CATALOG, CREATED);

function byId(id) {
  return LIST.data.find((m) => m.id === id);
}

describe("joining the two responses", () => {
  it("advertises family ids, collapsing thinking/effort suffix slugs", () => {
    assert.equal(LIST.object, "list");
    assert.deepEqual(
      LIST.data.map((m) => m.id),
      ["grok-4.6", "kimi-k3", "claude-sonnet-5", "composer-2.5-fast"]
    );
  });

  it("drops the picker placeholder from both halves", () => {
    assert.equal(findModel("default", LIST), null);
    assert.equal(findModel("default", buildModelList(null, CATALOG)), null);
  });

  it("lets the runnable list decide which names exist", () => {
    // cursor-grok-4.6-high is in the catalog only, so it is metadata, not an offer.
    assert.equal(byId("cursor-grok-4.6-high"), undefined);
  });

  it("carries the catalog metadata onto the family id", () => {
    assert.deepEqual(byId("grok-4.6"), {
      id: "grok-4.6",
      object: "model",
      created: CREATED,
      owned_by: "cursor",
      permission: [],
      root: "grok-4.6",
      parent: null,
      display_name: "Cursor Grok 4.6",
      context_window: 256000,
      supports_images: false,
      supports_thinking: true,
      supports_max_mode: true,
      supports_agent: true,
      aliases: ["cursor-grok-4.6-low", "grok-4.6-low"],
    });
  });

  it("keeps the vendor when the catalog names one", () => {
    assert.equal(byId("claude-sonnet-5").vendor, "Anthropic");
    assert.equal(byId("kimi-k3").vendor, undefined);
  });

  it("pools the alias spellings from both halves plus the collapsed slug", () => {
    assert.deepEqual(byId("kimi-k3").aliases, ["kimi-k3-max", "kimi-latest", "kimi-k3-latest"]);
  });
});

describe("context_window", () => {
  it("prefers the number the catalog states outright", () => {
    // The tooltip on this one says 1M; the field says 200k and wins.
    assert.equal(byId("claude-sonnet-5").context_window, 200000);
  });

  it("falls back to the tooltip prose", () => {
    assert.equal(byId("grok-4.6").context_window, 256000);
    assert.equal(byId("kimi-k3").context_window, 256000);
  });

  it("omits the field rather than guessing", () => {
    // No catalog record at all.
    assert.equal("context_window" in byId("composer-2.5-fast"), false);
    // high's tooltip says 1M, which this parser refuses. Collapse keeps the
    // first member's parseable 256k instead of guessing the 1M unit.
    const catalogOnly = buildModelList(null, CATALOG);
    assert.equal(findModel("cursor-grok-4.6-high", catalogOnly).id, "grok-4.6");
    assert.equal(findModel("cursor-grok-4.6-high", catalogOnly).context_window, 256000);
  });

  it("reads k and bare numbers, and nothing else", () => {
    assert.equal(parseContextWindow("256k context window"), 256000);
    assert.equal(parseContextWindow("1000K context window"), 1000000);
    assert.equal(parseContextWindow("256000 context window"), 256000);
    assert.equal(parseContextWindow("200,000 context window"), 200000);
    assert.equal(parseContextWindow("1M context window"), null);
    assert.equal(parseContextWindow("a big context window"), null);
    assert.equal(parseContextWindow(""), null);
    assert.equal(parseContextWindow(undefined), null);
  });
});

describe("capability flags", () => {
  it("reports an explicit false as false", () => {
    assert.equal(byId("grok-4.6").supports_images, false);
  });

  it("reports an absent flag as false, because proto3 drops defaults", () => {
    // The whole kimi line cannot see images and says so by saying nothing.
    assert.equal(byId("kimi-k3").supports_images, false);
    assert.equal(byId("kimi-k3").supports_thinking, true);
  });

  it("reports a true as true", () => {
    assert.equal(byId("claude-sonnet-5").supports_images, true);
  });

  it("claims nothing for a model the catalog never mentioned", () => {
    const bare = byId("composer-2.5-fast");
    assert.equal(bare.supports_images, undefined);
    assert.equal(bare.supports_thinking, undefined);
    assert.equal(bare.supports_max_mode, undefined);
    assert.equal(bare.supports_agent, undefined);
    // The runnable half still knew what to call it.
    assert.equal(bare.display_name, "Composer 2.5");
    assert.equal(bare.id, "composer-2.5-fast");
  });
});

describe("one half missing", () => {
  it("lists the runnable names alone, undecorated", () => {
    const body = buildModelList(USABLE, null, CREATED);
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["grok-4.6", "kimi-k3", "claude-sonnet-5", "composer-2.5-fast"]
    );
    assert.deepEqual(body.data[0], {
      id: "grok-4.6",
      object: "model",
      created: CREATED,
      owned_by: "cursor",
      permission: [],
      root: "grok-4.6",
      parent: null,
      display_name: "Cursor Grok 4.6",
      aliases: ["cursor-grok-4.6-low"],
    });
    assert.equal(findModel("kimi-latest", body).id, "kimi-k3");
  });

  it("falls back to the catalog names, which also run", () => {
    const body = buildModelList(null, CATALOG, CREATED);
    assert.deepEqual(
      body.data.map((m) => m.id),
      ["grok-4.6", "kimi-k3", "claude-sonnet-5"]
    );
    assert.equal(findModel("cursor-grok-4.6-low", body).context_window, 256000);
    assert.equal(findModel("cursor-grok-4.6-low", body).id, "grok-4.6");
  });

  it("answers an empty list when neither half arrived", () => {
    assert.deepEqual(buildModelList(null, null), { object: "list", data: [] });
    assert.deepEqual(buildModelList({}, { models: [] }), { object: "list", data: [] });
  });
});

describe("findModel", () => {
  it("matches the family id exactly", () => {
    assert.equal(findModel("kimi-k3", LIST).id, "kimi-k3");
  });

  it("matches an alias from either half, including a collapsed suffix slug", () => {
    assert.equal(findModel("grok-4.6-low", LIST).id, "grok-4.6");
    assert.equal(findModel("kimi-latest", LIST).id, "kimi-k3");
    assert.equal(findModel("kimi-k3-max", LIST).id, "kimi-k3");
  });

  it("does not care about case", () => {
    assert.equal(findModel("KIMI-K3-MAX", LIST).id, "kimi-k3");
    assert.equal(findModel("Kimi-Latest", LIST).id, "kimi-k3");
  });

  it("takes the data array as readily as the whole body", () => {
    assert.equal(findModel("kimi-k3-max", LIST.data).id, "kimi-k3");
  });

  it("answers null for anything it does not carry", () => {
    assert.equal(findModel("gpt-4o", LIST), null);
    assert.equal(findModel("", LIST), null);
    assert.equal(findModel("kimi-k3-max", null), null);
  });
});

describe("buildModelObject", () => {
  it("wraps a bare id in the OpenAI shape", () => {
    assert.deepEqual(buildModelObject("kimi-k3-max", CREATED), {
      id: "kimi-k3-max",
      object: "model",
      created: CREATED,
      owned_by: "cursor",
      permission: [],
      root: "kimi-k3-max",
      parent: null,
    });
  });

  it("stamps created in unix seconds when none is given", () => {
    const now = Math.floor(Date.now() / 1000);
    const model = buildModelObject("kimi-k3-max");
    assert.ok(model.created >= now && model.created <= now + 2);
  });

  it("keeps the metadata when handed back a model it already built", () => {
    const original = byId("claude-sonnet-5");
    assert.deepEqual(buildModelObject(original, CREATED), original);
  });
});

const START = 1756500000000;

function stub(value) {
  const fn = async () => {
    fn.calls++;
    return typeof value === "function" ? value() : value;
  };
  fn.calls = 0;
  return fn;
}

function failing(message) {
  return stub(() => {
    throw new Error(message);
  });
}

describe("the cached manager", () => {
  it("reports nothing before the first load", () => {
    const models = createModelList({ fetchUsable: stub(USABLE), fetchCatalog: stub(CATALOG) });
    assert.deepEqual(models.status(), {
      source: "none",
      models: 0,
      withMetadata: 0,
      fetchedAt: 0,
      ageMs: 0,
      error: null,
    });
  });

  it("joins both halves and says so", async () => {
    const models = createModelList({ fetchUsable: stub(USABLE), fetchCatalog: stub(CATALOG) });
    const body = await models.list();
    assert.equal(body.data.length, 4);
    const status = models.status();
    assert.equal(status.source, "upstream");
    assert.equal(status.models, 4);
    // composer-2.5-fast is runnable but uncatalogued.
    assert.equal(status.withMetadata, 3);
    assert.equal(status.error, null);
  });

  it("still lists when only the runnable names came back", async () => {
    const models = createModelList({
      fetchUsable: stub(USABLE),
      fetchCatalog: failing("catalog down"),
    });
    const body = await models.list();
    assert.equal(body.data.length, 4);
    assert.equal(body.data[0].supports_images, undefined);
    const status = models.status();
    assert.equal(status.source, "partial");
    assert.equal(status.withMetadata, 0);
    assert.match(status.error, /catalog down/);
  });

  it("still lists when only the catalog came back", async () => {
    const models = createModelList({
      fetchUsable: failing("no token"),
      fetchCatalog: stub(CATALOG),
    });
    const body = await models.list();
    assert.equal(body.data.length, 3);
    assert.equal(models.status().withMetadata, 3);
    assert.match(models.status().error, /no token/);
  });

  it("resolves an alias through the cache", async () => {
    const models = createModelList({ fetchUsable: stub(USABLE), fetchCatalog: stub(CATALOG) });
    assert.equal((await models.find("grok-4.6-low")).id, "grok-4.6");
    assert.equal(await models.find("gpt-4o"), null);
  });

  it("treats an empty response as a failure", async () => {
    const models = createModelList({
      fetchUsable: stub({ models: [] }),
      fetchCatalog: stub({ models: [] }),
    });
    await assert.rejects(models.list(), /listed no models/);
  });

  it("serves the cached list for the full ttl", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: START });
    const usable = stub(USABLE);
    const models = createModelList({
      fetchUsable: usable,
      fetchCatalog: stub(CATALOG),
      ttlMs: 900000,
    });

    await models.list();
    t.mock.timers.tick(899000);
    await models.list();
    assert.equal(usable.calls, 1);
    assert.equal(models.status().ageMs, 899000);

    t.mock.timers.tick(2000);
    await models.list();
    assert.equal(usable.calls, 2);
  });

  it("keeps the last good list when both halves fail", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: START });
    let broken = false;
    const models = createModelList({
      fetchUsable: async () => {
        if (broken) throw new Error("boom");
        return USABLE;
      },
      fetchCatalog: async () => {
        if (broken) throw new Error("nope");
        return CATALOG;
      },
      ttlMs: 900000,
      errorTtlMs: 60000,
    });

    const first = await models.list();
    broken = true;
    t.mock.timers.tick(900001);
    const second = await models.list();

    assert.deepEqual(second, first);
    assert.equal(models.status().source, "stale");
    assert.match(models.status().error, /boom.*nope/);
  });

  it("throws when both halves fail and nothing is cached", async () => {
    const models = createModelList({
      fetchUsable: failing("boom"),
      fetchCatalog: failing("nope"),
    });
    await assert.rejects(models.list(), /usable models: boom; model catalog: nope/);
    assert.equal(models.status().models, 0);
    assert.equal(models.status().source, "none");
  });

  it("retries a failure on the short ttl, not the full one", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: START });
    const usable = failing("boom");
    const models = createModelList({
      fetchUsable: usable,
      fetchCatalog: failing("nope"),
      ttlMs: 900000,
      errorTtlMs: 60000,
    });

    await assert.rejects(models.list(), /boom/);
    t.mock.timers.tick(59000);
    // A refusal is cached too, briefly, so a busy proxy cannot hammer upstream.
    await assert.rejects(models.list(), /boom/);
    assert.equal(usable.calls, 1);

    t.mock.timers.tick(2000);
    await assert.rejects(models.list(), /boom/);
    assert.equal(usable.calls, 2);
  });

  it("refetches on refresh whatever the ttl says", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: START });
    const usable = stub(USABLE);
    const models = createModelList({
      fetchUsable: usable,
      fetchCatalog: stub(CATALOG),
      ttlMs: 900000,
    });

    await models.list();
    await models.refresh();
    assert.equal(usable.calls, 2);
  });

  it("fetches once for concurrent callers", async () => {
    const usable = stub(USABLE);
    const models = createModelList({ fetchUsable: usable, fetchCatalog: stub(CATALOG) });
    await Promise.all([models.list(), models.list(), models.find("kimi-k3-max")]);
    assert.equal(usable.calls, 1);
  });
});
