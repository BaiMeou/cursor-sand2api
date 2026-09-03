const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { modelCovered, namesOf, createAccountModels, parseQuotaReset } = require("../src/account-models");
const { prefixOfficialUsable } = require("../src/model-route");

describe("namesOf", () => {
  it("reads sand GetUsableModels objects and official name lists", () => {
    assert.deepEqual(namesOf({ models: [{ modelId: "kimi-k3-max" }, { name: "composer-2.5" }] }).sort(), [
      "composer-2.5",
      "kimi-k3-max",
    ]);
    assert.deepEqual(namesOf({ models: [{ name: "kimi-k3" }] }), ["kimi-k3"]);
    assert.deepEqual(namesOf({ models: ["default", "grok-4.6"] }), ["grok-4.6"]);
  });
});

describe("modelCovered", () => {
  it("lets an official kimi-k3 catalog cover api-kimi-k3-max", () => {
    const ids = new Set(["kimi-k3", "composer-2.5"]);
    assert.equal(modelCovered(ids, "api-kimi-k3-max", true), true);
    assert.equal(modelCovered(ids, "api-composer-2.5", true), true);
    assert.equal(modelCovered(ids, "api-claude-opus-5", true), false);
  });

  it("does not let a sand kimi id cover an official request", () => {
    const ids = new Set(["kimi-k3-max"]);
    assert.equal(modelCovered(ids, "kimi-k3-max", false), true);
    assert.equal(modelCovered(ids, "api-kimi-k3-max", true), false);
  });

  it("fails closed on an empty allowlist and open on a missing one", () => {
    assert.equal(modelCovered(new Set(), "kimi-k3-max", false), false);
    assert.equal(modelCovered(null, "kimi-k3-max", false), true);
  });

  it("lets a sand family id cover any of that family's suffix slugs", () => {
    const ids = new Set(["kimi-k3-max", "claude-fable-5-1-thinking-high"]);
    assert.equal(modelCovered(ids, "kimi-k3", false), true);
    assert.equal(modelCovered(ids, "claude-fable-5.1", false), true);
    assert.equal(modelCovered(ids, "claude-sonnet-5", false), false);
  });
});

describe("account model union", () => {
  it("unions per-account catalogs and keeps the kinds apart", async () => {
    const index = createAccountModels({
      ttlMs: 60_000,
      fetchSand: async (acc) => ({ models: acc.accessToken === "a" ? ["kimi-k3-max"] : ["composer-2.5"] }),
      fetchOfficial: async () => ({ models: [{ name: "kimi-k3" }, { name: "grok-4.6" }] }),
    });
    await index.refresh([
      { name: "s1", kind: "sand", accessToken: "a" },
      { name: "s2", kind: "sand", accessToken: "b" },
      { name: "o1", kind: "api", apiKey: "crsr_x" },
    ]);
    assert.deepEqual([...index.union("sand")].sort(), ["composer-2.5", "kimi-k3-max"]);
    assert.deepEqual([...index.union("api")].sort(), ["grok-4.6", "kimi-k3"]);
    assert.equal(index.covers({ kind: "sand", accessToken: "a" }, "composer-2.5", false), false);
    assert.equal(index.covers({ kind: "api", apiKey: "crsr_x" }, "api-kimi-k3-max", true), true);
  });
});

describe("quota disable", () => {
  it("parses a Cursor monthly reset date", () => {
    const until = parseQuotaReset("Your usage limits will reset when your monthly cycle ends on 9/21/2026.");
    const d = new Date(until);
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 8);
    assert.equal(d.getUTCDate(), 21);
  });

  it("falls back to about 30 days when Cursor did not say a date", () => {
    const until = parseQuotaReset("verify: usage limit");
    const days = (until - Date.now()) / 86400000;
    assert.ok(days > 29 && days < 31);
  });

  it("drops a quota-exhausted official model from the union", async () => {
    const index = createAccountModels({
      ttlMs: 60_000,
      fetchSand: async () => ({ models: [] }),
      fetchOfficial: async () => ({ models: [{ name: "kimi-k3" }, { name: "grok-4.6" }] }),
    });
    const acc = { name: "o1", kind: "api", apiKey: "crsr_x" };
    await index.refresh([acc]);
    assert.equal(index.union("api").has("kimi-k3"), true);
    index.disable(acc, "api-kimi-k3-max", true, "You've hit your usage limit on 9/21/2026");
    assert.equal(index.union("api").has("kimi-k3"), false);
    assert.equal(index.union("api").has("grok-4.6"), true);
    assert.equal(index.covers(acc, "api-kimi-k3-max", true), false);
  });

  it("disables a whole sand family after a spend-limit 403", async () => {
    const index = createAccountModels({
      ttlMs: 60_000,
      fetchSand: async () => ({
        models: [
          { modelId: "claude-fable-5-1-thinking-max" },
          { modelId: "claude-fable-5-1-thinking-high" },
          { modelId: "kimi-k3-max" },
        ],
      }),
      fetchOfficial: async () => ({ models: [] }),
    });
    const acc = { name: "s1", kind: "sand", accessToken: "jwt-s" };
    await index.refresh([acc]);
    index.disable(acc, "claude-fable-5-1-thinking-max", false, "Upgrade to a paid plan", { family: true });
    assert.equal(index.covers(acc, "claude-fable-5-1-thinking-max", false), false);
    assert.equal(index.covers(acc, "claude-fable-5-1-thinking-high", false), false);
    assert.equal(index.covers(acc, "kimi-k3-max", false), true);
  });
});

describe("official listing does not explode variants into extra ids", () => {
  it("keeps one row per catalog id and puts suffixes in aliases", () => {
    const out = prefixOfficialUsable({ models: [{ name: "kimi-k3", displayName: "Kimi K3" }] });
    const ids = out.models.map((m) => m.name);
    assert.deepEqual(ids, ["api-kimi-k3"]);
    assert.ok(out.models[0].aliases.includes("api-kimi-k3-max"));
  });
});
