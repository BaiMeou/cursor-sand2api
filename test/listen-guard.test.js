const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  isLoopbackHost,
  resolveWebUi,
  requireApiKeyForBind,
  corsOriginOption,
} = require("../src/listen-guard");

describe("listen-guard", () => {
  it("treats loopback names as local", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
  });

  it("defaults WEB_UI to on only on loopback", () => {
    assert.equal(resolveWebUi("", "127.0.0.1"), true);
    assert.equal(resolveWebUi("", "0.0.0.0"), false);
    assert.equal(resolveWebUi("on", "0.0.0.0"), true);
    assert.equal(resolveWebUi("off", "127.0.0.1"), false);
  });

  it("refuses a public bind without API_KEY", () => {
    assert.equal(requireApiKeyForBind("", "0.0.0.0"), "Set API_KEY before binding to a non-loopback address");
    assert.equal(requireApiKeyForBind("secret", "0.0.0.0"), null);
    assert.equal(requireApiKeyForBind("", "127.0.0.1"), null);
  });

  it("locks CORS to loopback unless CORS_ORIGIN is set", () => {
    assert.equal(corsOriginOption("", "127.0.0.1"), true);
    assert.equal(corsOriginOption("", "0.0.0.0"), false);
    assert.equal(corsOriginOption("*", "0.0.0.0"), true);
    assert.deepEqual(corsOriginOption("https://a.example, https://b.example", "0.0.0.0"), [
      "https://a.example",
      "https://b.example",
    ]);
  });
});
