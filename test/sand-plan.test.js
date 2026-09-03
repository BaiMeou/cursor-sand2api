const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { isGrokBotPlan, grokPlanLabel, applyUsage } = require("../src/sand-plan");
const protocol = require("../src/openai-protocol");
const { penalize } = require("../src/penalize");
const config = require("../src/config");

describe("sand plan labels", () => {
  it("does not prefer Grok Bot Plan unless the operator turns it on", () => {
    assert.equal(config.tokens.preferGrokBotPlan, false);
  });

  it("treats Grok Bot Plan as the named-model weekly pool", () => {
    assert.equal(isGrokBotPlan({ grokPlanLabel: "Grok Bot Plan" }), true);
    assert.equal(isGrokBotPlan({ includedUsageSuperGrokPlan: "supergrok" }), false);
    assert.equal(isGrokBotPlan({ grokPlanLabel: "SuperGrok Heavy" }), false);
    assert.equal(grokPlanLabel({ grokPlanLabel: "Grok Bot Plan" }), "Grok Bot Plan");
  });

  it("copies usage onto the token without inventing a plan", () => {
    const token = { name: "x" };
    applyUsage(token, { grokPlanLabel: "Grok Bot Plan", usagePercent: 12, hasAvailableUsage: true });
    assert.equal(token.grokPlanLabel, "Grok Bot Plan");
    assert.equal(isGrokBotPlan(token), true);
  });
});

describe("plan_restricted routing", () => {
  it("failsover a spend-limit 403 onto another sand JWT", () => {
    const f = protocol.classifyUpstreamError("ERROR_RATE_LIMITED_CHANGEABLE: Upgrade to a paid plan or set a Spend Limit");
    assert.equal(f.code, "plan_restricted");
    assert.equal(protocol.shouldFailover(f), true);
  });

  it("disables the family on the SuperGrok account and does not bench it", () => {
    const disabled = [];
    const pool = {
      markFailure() {
        throw new Error("must not bench a plan_restricted account");
      },
    };
    const failure = penalize(
      pool,
      { name: "account-b", kind: "sand", accessToken: "jwt" },
      "ERROR_RATE_LIMITED_CHANGEABLE: Upgrade to a paid plan",
      "claude-fable-5-1-thinking-max",
      false,
      {
        protocol,
        accountModels: {
          disable(token, modelId, official, reason, opts) {
            disabled.push({ modelId, official, family: Boolean(opts && opts.family) });
          },
        },
        config: { tokens: { authCooldownMs: 0 } },
      }
    );
    assert.equal(failure.code, "plan_restricted");
    assert.deepEqual(disabled, [{ modelId: "claude-fable-5-1-thinking-max", official: false, family: true }]);
  });
});
