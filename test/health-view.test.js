const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { publicHealth, stripUsagePii } = require("../src/health-view");

describe("health-view", () => {
  it("publishes only status, version, and token counts", () => {
    const body = publicHealth({ version: "1.0.0", tokens: { total: 4, healthy: 3, accounts: [{ name: "secret" }] } });
    assert.deepEqual(body, { status: "ok", version: "1.0.0", tokens: { total: 4, healthy: 3 } });
    assert.equal(body.tokens.accounts, undefined);
  });

  it("marks zero healthy accounts as degraded", () => {
    assert.equal(publicHealth({ version: "1.0.0", tokens: { total: 2, healthy: 0 } }).status, "degraded");
  });

  it("strips dashboard URLs from usage snapshots", () => {
    const cleaned = stripUsagePii({
      usagePercent: 12,
      onDemandSettings: { visible: true, dashboardUrl: "https://cursor.com/dashboard/spending?for=auth0|user" },
    });
    assert.equal(cleaned.onDemandSettings.visible, true);
    assert.equal(cleaned.onDemandSettings.dashboardUrl, undefined);
  });
});
