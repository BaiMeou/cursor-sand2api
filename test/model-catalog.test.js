const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCatalog,
  normalizeEffort,
  nearestEffort,
  resolveModelParams,
  createCatalog,
  EFFORT_LADDER,
  EFFORT_ALIASES,
  EFFORT_BUDGETS,
} = require("../src/model-catalog");

function enumValues(...values) {
  return { enumOptions: values.map((value) => ({ value, label: value })) };
}

// Shaped like the catalog RPC decoded through a JSON codec.
const RAW = {
  models: [
    {
      name: "claude-fable-5",
      clientDisplayName: "Claude Fable 5",
      supportsThinking: true,
      parameterDefinitions: [
        {
          id: "thinking",
          displayName: "Thinking",
          values: { boolOptions: [{ value: "true" }, { value: "false" }] },
        },
        { id: "effort", displayName: "Effort", values: enumValues("low", "medium", "high", "max") },
      ],
      idAliases: ["claude-fable-5-latest"],
      legacySlugs: ["claude-fable-5-thinking-high"],
    },
    {
      name: "kimi-k3",
      parameterDefinitions: [{ id: "reasoning", values: enumValues("low", "high", "xhigh") }],
    },
    {
      name: "composer-2.5",
      parameterDefinitions: [{ id: "fast", values: { boolOptions: [{ value: "true" }] } }],
    },
    { name: "auto" },
    { name: "default", parameterDefinitions: [{ id: "effort", values: enumValues("high") }] },
  ],
};

describe("parseCatalog", () => {
  it("reads ids, parameters, aliases and slugs off a full response", () => {
    const table = parseCatalog(RAW);
    assert.deepEqual(Object.keys(table), ["claude-fable-5", "kimi-k3", "composer-2.5", "auto"]);
    assert.deepEqual(table["claude-fable-5"].params, {
      thinking: ["true", "false"],
      effort: ["low", "medium", "high", "max"],
    });
    assert.deepEqual(table["claude-fable-5"].aliases, ["claude-fable-5-latest"]);
    assert.deepEqual(table["claude-fable-5"].legacySlugs, ["claude-fable-5-thinking-high"]);
    assert.deepEqual(table["kimi-k3"].params, { reasoning: ["low", "high", "xhigh"] });
  });

  it("skips the picker placeholder and keeps a model that declares nothing", () => {
    const table = parseCatalog(RAW);
    assert.equal(table.default, undefined);
    assert.deepEqual(table.auto, { params: {}, variants: [], aliases: [], legacySlugs: [] });
  });

  it("accepts the snake_case spelling of every field", () => {
    const table = parseCatalog({
      models: [
        {
          model_id: "grok-4.6",
          parameter_definitions: [{ id: "effort", values: { enum_options: [{ value: "high" }] } }],
          id_aliases: ["grok"],
          legacy_slugs: ["cursor-grok-4.6-high"],
        },
      ],
    });
    assert.deepEqual(table["grok-4.6"], {
      params: { effort: ["high"] },
      variants: [],
      aliases: ["grok"],
      legacySlugs: ["cursor-grok-4.6-high"],
    });
  });

  it("reads the agent RPC shape, which carries ids and no parameters", () => {
    const table = parseCatalog({ models: [{ modelId: "kimi-k3-max" }, { modelId: "composer-2.5" }] });
    assert.deepEqual(Object.keys(table), ["kimi-k3-max", "composer-2.5"]);
    assert.deepEqual(table["kimi-k3-max"].params, {});
  });

  it("accepts a bare list of option strings", () => {
    const table = parseCatalog({
      models: [{ name: "m", parameterDefinitions: [{ id: "effort", values: ["low", "high"] }] }],
    });
    assert.deepEqual(table.m.params, { effort: ["low", "high"] });
  });

  it("drops a definition with no id and one with no readable values", () => {
    const table = parseCatalog({
      models: [
        {
          name: "m",
          parameterDefinitions: [
            { id: "", values: enumValues("high") },
            { id: "effort", values: {} },
            { id: "reasoning", values: enumValues("high") },
          ],
        },
      ],
    });
    assert.deepEqual(table.m.params, { reasoning: ["high"] });
  });

  it("survives a missing, empty or malformed response", () => {
    assert.deepEqual(parseCatalog(undefined), {});
    assert.deepEqual(parseCatalog(null), {});
    assert.deepEqual(parseCatalog({}), {});
    assert.deepEqual(parseCatalog({ models: null }), {});
    assert.deepEqual(parseCatalog("nope"), {});
    assert.deepEqual(parseCatalog({ models: [null, 7, {}, { name: "" }] }), {});
  });

  it("takes the models array on its own", () => {
    assert.deepEqual(Object.keys(parseCatalog([{ name: "solo" }])), ["solo"]);
  });
});

describe("effort constants", () => {
  it("runs weakest to strongest", () => {
    assert.deepEqual(EFFORT_LADDER, ["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(EFFORT_ALIASES, { minimal: "low", default: "medium", highest: "max" });
    assert.deepEqual(EFFORT_BUDGETS, [
      [1024, "low"],
      [2048, "medium"],
    ]);
  });
});

describe("normalizeEffort", () => {
  it("reads all four spellings", () => {
    assert.equal(normalizeEffort({ reasoning_effort: "high" }), "high");
    assert.equal(normalizeEffort({ reasoning: { effort: "low" } }), "low");
    assert.equal(normalizeEffort({ thinking: { effort: "max" } }), "max");
    assert.equal(normalizeEffort({ thinking: { type: "enabled", budget_tokens: 4096 } }), "max");
  });

  it("folds the aliases onto the ladder", () => {
    assert.equal(normalizeEffort({ reasoning_effort: "minimal" }), "low");
    assert.equal(normalizeEffort({ reasoning_effort: "default" }), "medium");
    assert.equal(normalizeEffort({ reasoning_effort: "highest" }), "max");
  });

  it("ignores case and padding", () => {
    assert.equal(normalizeEffort({ reasoning_effort: "  HIGH " }), "high");
    assert.equal(normalizeEffort({ thinking: { effort: "XHigh" } }), "xhigh");
  });

  it("buckets a token budget on the cutoffs", () => {
    const at = (budget_tokens) => normalizeEffort({ thinking: { budget_tokens } });
    assert.equal(at(512), "low");
    assert.equal(at(1024), "low");
    assert.equal(at(1025), "medium");
    assert.equal(at(2048), "medium");
    assert.equal(at(2049), "max");
    assert.equal(at(32000), "max");
    assert.equal(at("4096"), "max");
    assert.equal(at(4096), normalizeEffort({ thinking: { budgetTokens: 4096 } }));
  });

  it("prefers a named level over a budget in the same block", () => {
    assert.equal(normalizeEffort({ thinking: { effort: "low", budget_tokens: 32000 } }), "low");
  });

  it("returns null when the caller asked for nothing usable", () => {
    assert.equal(normalizeEffort({}), null);
    assert.equal(normalizeEffort(undefined), null);
    assert.equal(normalizeEffort({ reasoning_effort: "" }), null);
    assert.equal(normalizeEffort({ thinking: { type: "disabled" } }), null);
    assert.equal(normalizeEffort({ thinking: { budget_tokens: null } }), null);
    assert.equal(normalizeEffort({ thinking: { budget_tokens: "lots" } }), null);
    assert.equal(normalizeEffort({ reasoning: "high" }), null);
  });

  it("passes an unknown level through for the clamp to reject", () => {
    assert.equal(normalizeEffort({ reasoning_effort: "turbo" }), "turbo");
  });
});

describe("nearestEffort", () => {
  const allowed = ["low", "medium", "high", "xhigh"];

  it("keeps a level the model publishes", () => {
    assert.equal(nearestEffort("medium", allowed), "medium");
  });

  it("steps down to the strongest level the model actually offers", () => {
    assert.equal(nearestEffort("max", allowed), "xhigh");
    assert.equal(nearestEffort("max", ["low", "medium", "high"]), "high");
  });

  it("steps up when the model starts above what was asked for", () => {
    assert.equal(nearestEffort("none", allowed), "low");
    assert.equal(nearestEffort("minimal", ["medium", "max"]), "medium");
  });

  it("breaks a tie towards the stronger rung", () => {
    assert.equal(nearestEffort("medium", ["low", "high"]), "high");
  });

  it("returns the value with the catalog's own spelling", () => {
    assert.equal(nearestEffort("high", ["LOW", "High"]), "High");
    assert.equal(nearestEffort("max", ["Low", "High"]), "High");
  });

  it("gives up rather than inventing a value", () => {
    assert.equal(nearestEffort("turbo", allowed), null);
    assert.equal(nearestEffort("high", []), null);
    assert.equal(nearestEffort("high", undefined), null);
    assert.equal(nearestEffort("high", ["fast", "slow"]), null);
    assert.equal(nearestEffort("", allowed), null);
  });
});

describe("resolveModelParams", () => {
  const catalog = parseCatalog(RAW);
  const high = { reasoning_effort: "high" };

  it("sends nothing for a model that declares no reasoning parameter", () => {
    assert.deepEqual(resolveModelParams("auto", high, catalog), []);
    assert.deepEqual(resolveModelParams("composer-2.5", high, catalog), []);
  });

  it("sends nothing for a model the catalog has never heard of", () => {
    assert.deepEqual(resolveModelParams("kimi-k9-ultra", high, catalog), []);
  });

  it("sends nothing when there is no catalog at all", () => {
    assert.deepEqual(resolveModelParams("claude-fable-5", high, {}), []);
    assert.deepEqual(resolveModelParams("claude-fable-5", high, undefined), []);
    assert.deepEqual(resolveModelParams("", high, catalog), []);
  });

  it("uses the id the model publishes", () => {
    assert.deepEqual(resolveModelParams("claude-fable-5", high, catalog), [
      { id: "effort", value: "high" },
    ]);
    assert.deepEqual(resolveModelParams("kimi-k3", high, catalog), [
      { id: "reasoning", value: "high" },
    ]);
  });

  it("sends one parameter, not both, when a model declares both", () => {
    const both = parseCatalog({
      models: [
        {
          name: "m",
          parameterDefinitions: [
            { id: "reasoning", values: enumValues("low", "high") },
            { id: "effort", values: enumValues("low", "high") },
          ],
        },
      ],
    });
    assert.deepEqual(resolveModelParams("m", high, both), [{ id: "effort", value: "high" }]);
  });

  it("clamps the level onto what the model publishes", () => {
    assert.deepEqual(resolveModelParams("kimi-k3", { reasoning_effort: "max" }, catalog), [
      { id: "reasoning", value: "xhigh" },
    ]);
    assert.deepEqual(resolveModelParams("claude-fable-5", { thinking: { budget_tokens: 1024 } }, catalog), [
      { id: "effort", value: "low" },
    ]);
  });

  it("sends nothing when the request asked for no particular depth", () => {
    assert.deepEqual(resolveModelParams("claude-fable-5", {}, catalog), []);
    assert.deepEqual(resolveModelParams("claude-fable-5", undefined, catalog), []);
  });

  it("sends nothing when the level has no counterpart on the model", () => {
    assert.deepEqual(resolveModelParams("kimi-k3", { reasoning_effort: "turbo" }, catalog), []);
  });

  it("finds the model behind an alias or a legacy slug", () => {
    assert.deepEqual(resolveModelParams("claude-fable-5-latest", high, catalog), [
      { id: "effort", value: "high" },
    ]);
    assert.deepEqual(resolveModelParams("claude-fable-5-thinking-high", high, catalog), [
      { id: "effort", value: "high" },
    ]);
  });

  it("accepts a hand-written table that only lists parameters", () => {
    const table = { "gpt-5.6-sol": { params: { reasoning: ["low", "medium", "high"] } } };
    assert.deepEqual(resolveModelParams("gpt-5.6-sol", high, table), [
      { id: "reasoning", value: "high" },
    ]);
  });
});

describe("createCatalog", () => {
  function stub(responses) {
    const calls = [];
    const queue = [...responses];
    return {
      calls,
      async fetchCatalog() {
        calls.push(Date.now());
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }

  it("fetches once and serves the cache until the TTL runs out", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const upstream = stub([RAW]);
    const catalog = createCatalog({ ...upstream, ttlMs: 1000 });

    assert.deepEqual(await catalog.get("kimi-k3"), {
      params: { reasoning: ["low", "high", "xhigh"] },
      variants: [],
      aliases: [],
      legacySlugs: [],
    });
    t.mock.timers.tick(999);
    await catalog.get("kimi-k3");
    assert.equal(upstream.calls.length, 1);

    t.mock.timers.tick(2);
    await catalog.get("kimi-k3");
    assert.equal(upstream.calls.length, 2);
  });

  it("shares one fetch between concurrent callers", async () => {
    const upstream = stub([RAW]);
    const catalog = createCatalog(upstream);
    await Promise.all([catalog.get("kimi-k3"), catalog.get("auto"), catalog.get()]);
    assert.equal(upstream.calls.length, 1);
  });

  it("returns the whole table when asked without an id, and null for a stranger", async () => {
    const catalog = createCatalog(stub([RAW]));
    assert.deepEqual(Object.keys(await catalog.get()), [
      "claude-fable-5",
      "kimi-k3",
      "composer-2.5",
      "auto",
    ]);
    assert.equal(await catalog.get("nope"), null);
  });

  it("refresh() refetches without waiting for the TTL", async () => {
    const upstream = stub([RAW]);
    const catalog = createCatalog(upstream);
    await catalog.get();
    await catalog.refresh();
    assert.equal(upstream.calls.length, 2);
  });

  it("keeps serving the last good table when a refetch fails, and retries on the short TTL", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const upstream = stub([RAW, new Error("upstream 503")]);
    const catalog = createCatalog({ ...upstream, ttlMs: 1000, errorTtlMs: 100 });

    await catalog.get();
    t.mock.timers.tick(1001);
    const table = await catalog.get();
    assert.deepEqual(Object.keys(table).length, 4);
    assert.equal(upstream.calls.length, 2);

    const status = catalog.status();
    assert.equal(status.source, "stale");
    assert.match(status.error, /503/);

    // The error TTL, not the success TTL, decides when the next attempt runs.
    t.mock.timers.tick(99);
    await catalog.get();
    assert.equal(upstream.calls.length, 2);
    t.mock.timers.tick(2);
    await catalog.get();
    assert.equal(upstream.calls.length, 3);
  });

  it("falls back without throwing when the catalog was never reachable", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const upstream = stub([new Error("offline")]);
    const catalog = createCatalog({
      ...upstream,
      ttlMs: 1000,
      errorTtlMs: 100,
      fallback: { "claude-fable-5": { params: { effort: ["low", "high"] } } },
    });

    const table = await catalog.get();
    assert.deepEqual(resolveModelParams("claude-fable-5", { reasoning_effort: "max" }, table), [
      { id: "effort", value: "high" },
    ]);
    assert.equal(catalog.status().source, "fallback");

    t.mock.timers.tick(101);
    await catalog.get();
    assert.equal(upstream.calls.length, 2);
  });

  it("serves an empty table rather than throwing when there is no fallback either", async () => {
    const catalog = createCatalog(stub([new Error("offline")]));
    assert.deepEqual(await catalog.get(), {});
    assert.equal(await catalog.get("kimi-k3"), null);
    assert.deepEqual(resolveModelParams("kimi-k3", { reasoning_effort: "high" }, await catalog.get()), []);
    assert.equal(catalog.status().source, "fallback");
  });

  it("survives a fetcher that was never wired up", async () => {
    const catalog = createCatalog();
    assert.deepEqual(await catalog.get(), {});
    assert.equal(catalog.status().source, "fallback");
  });

  it("treats a catalog with no models as a failure, not as a fresh empty answer", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    const upstream = stub([{ models: [] }]);
    const catalog = createCatalog({
      ...upstream,
      ttlMs: 100000,
      errorTtlMs: 100,
      fallback: { "kimi-k3": { params: { reasoning: ["high"] } } },
    });

    assert.deepEqual(Object.keys(await catalog.get()), ["kimi-k3"]);
    assert.equal(catalog.status().source, "fallback");
    t.mock.timers.tick(101);
    await catalog.get();
    assert.equal(upstream.calls.length, 2);
  });

  it("reports how many models carry parameters, which is what proves the transport", async () => {
    const withParams = createCatalog(stub([RAW]));
    await withParams.get();
    const status = withParams.status();
    assert.equal(status.source, "upstream");
    assert.equal(status.models, 4);
    assert.equal(status.withParams, 3);
    assert.equal(status.error, null);

    // The same models over a transport that drops parameter definitions.
    const idsOnly = createCatalog(stub([{ models: [{ modelId: "kimi-k3-max" }] }]));
    await idsOnly.get();
    assert.equal(idsOnly.status().withParams, 0);
  });
});
