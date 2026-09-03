const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { encodeFrame, createFrameReader } = require("../src/connect-frame");
const { TokenPool, jwtExpiryMs } = require("../src/token-pool");
const protocol = require("../src/openai-protocol");
const map = require("../src/openai-map");
const config = require("../src/config");
const converter = require("../src/converter");
const { penalize, sendHttpFailure } = require("../src/penalize");

function frame(flags, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

describe("connect envelope", () => {
  it("round-trips an encoded frame", () => {
    const read = createFrameReader();
    const out = read(encodeFrame({ clientHeartbeat: {} }));
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { kind: "message", message: { clientHeartbeat: {} } });
  });

  it("reassembles a frame split across chunks", () => {
    const read = createFrameReader();
    const buf = frame(0, JSON.stringify({ interactionUpdate: { textDelta: { text: "pong" } } }));
    assert.deepEqual(read(buf.subarray(0, 3)), []);
    assert.deepEqual(read(buf.subarray(3, 9)), []);
    const out = read(buf.subarray(9));
    assert.equal(out.length, 1);
    assert.equal(out[0].message.interactionUpdate.textDelta.text, "pong");
  });

  it("yields several frames from one chunk and keeps the tail", () => {
    const read = createFrameReader();
    const a = frame(0, JSON.stringify({ a: 1 }));
    const b = frame(0, JSON.stringify({ b: 2 }));
    const out = read(Buffer.concat([a, b, b.subarray(0, 4)]));
    assert.equal(out.length, 2);
    assert.deepEqual(out[1].message, { b: 2 });
    assert.equal(read(b.subarray(4)).length, 1);
  });

  it("gunzips compressed payloads", () => {
    const read = createFrameReader();
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ kvServerMessage: { id: 7 } })));
    const out = read(frame(0x01, gz));
    assert.deepEqual(out[0].message, { kvServerMessage: { id: 7 } });
  });

  it("surfaces a connect error hidden in the end-of-stream trailer", () => {
    const read = createFrameReader();
    const out = read(
      frame(0x02, JSON.stringify({ error: { code: "resource_exhausted", message: "quota" } }))
    );
    assert.equal(out[0].kind, "trailer");
    assert.equal(out[0].error, "resource_exhausted: quota");
  });

  it("treats a clean trailer as no error", () => {
    const read = createFrameReader();
    const out = read(frame(0x02, JSON.stringify({ metadata: {} })));
    assert.equal(out[0].kind, "trailer");
    assert.equal(out[0].error, null);
  });

  it("reports undecodable payloads instead of dropping them silently", () => {
    const read = createFrameReader();
    const out = read(frame(0, "not json"));
    assert.equal(out[0].kind, "invalid");
    assert.match(out[0].error, /not JSON/);
  });
});

describe("McpArgs over connect+json", () => {
  // Shape observed live on 2026-08-30: natural JSON, not base64 protobuf. A
  // base64 reading turns "Osaka" into ":\u01a4", which is how this was caught.
  it("keeps caller arguments exactly as the server sent them", () => {
    const args = { city: "Osaka", opts: { units: "celsius" }, days: [1, 2], strict: true };
    assert.deepEqual(map.decodeMcpArgs(args), args);
    assert.notEqual(map.decodeMcpArgs(args).city, ":\u01a4");
  });

  it("tolerates a missing args map", () => {
    assert.deepEqual(map.decodeMcpArgs(undefined), {});
    assert.deepEqual(map.decodeMcpArgs(null), {});
  });

  it("maps an mcpArgs exec to an OpenAI tool_call and keeps Cursor's call id", () => {
    const call = map.execToToolCall({
      mcpArgs: {
        name: "get_weather",
        toolName: "get_weather",
        toolCallId: "toolu_abc123",
        args: { city: "Osaka", opts: { units: "celsius" } },
      },
    });
    assert.equal(call.id, "toolu_abc123");
    assert.equal(call.function.name, "get_weather");
    assert.deepEqual(JSON.parse(call.function.arguments), {
      city: "Osaka",
      opts: { units: "celsius" },
    });
    assert.equal(call._resultKey, "mcpResult");
  });

  it("returns an McpSuccess content array, not a bare string", () => {
    const call = { _resultKey: "mcpResult", function: { name: "get_weather", arguments: "{}" } };
    const payload = map.toolResultToExecPayload(call, '{"temp_c":31}');
    assert.equal(payload.success.isError, false);
    assert.equal(payload.success.content[0].text.text, '{"temp_c":31}');
  });
});

describe("MCP tool declaration", () => {
  const tools = [
    {
      type: "function",
      function: { name: "search_web", description: "Search", parameters: { type: "object" } },
    },
  ];

  it("drops the invoke_client_tool protocol once tools are registered natively", () => {
    const native = map.extraToolsPrompt(tools, "", true);
    assert.doesNotMatch(native, /emit exactly one line/);
    assert.match(native, /never emit invoke_client_tool/i);
    assert.match(native, /search_web/);
    assert.doesNotMatch(native, /parameters:/);
  });

  it("keeps the text protocol when tools are not registered natively", () => {
    const fallback = map.extraToolsPrompt(tools, "", false);
    assert.match(fallback, /invoke_client_tool \{"name"/);
    assert.doesNotMatch(fallback, /OpenAI Chat Completions converter/);
  });

  it("turns OpenAI functions into McpToolDefinition entries", () => {
    const defs = map.buildMcpToolDefinitions([
      {
        type: "function",
        function: {
          name: "search_web",
          description: "Search",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
      { type: "function", function: {} },
    ]);
    assert.equal(defs.length, 1);
    assert.equal(defs[0].name, "search_web");
    assert.equal(defs[0].toolName, "search_web");
    assert.deepEqual(JSON.parse(defs[0].inputSchemaJson), {
      type: "object",
      properties: { q: { type: "string" } },
    });
  });
});

function writePool(tokens) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sand2api-")), "token.json");
  fs.writeFileSync(file, JSON.stringify({ tokens }));
  return file;
}

function jwt(expSeconds) {
  const claims = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `header.${claims}.sig`;
}

describe("token pool", () => {
  it("round-robins and skips accounts in cooldown", () => {
    const pool = new TokenPool(writePool([{ accessToken: "a" }, { accessToken: "b" }]), { cooldownMs: 60_000 });
    pool.load();
    assert.equal(pool.next().accessToken, "a");
    assert.equal(pool.next().accessToken, "b");

    pool.markFailure({ accessToken: "a" }, "429");
    assert.equal(pool.status().healthy, 1);
    assert.equal(pool.next().accessToken, "b");
    assert.equal(pool.next().accessToken, "b");

    pool.markSuccess({ accessToken: "a" });
    assert.equal(pool.status().healthy, 2);
  });

  it("still hands out an account when every one is cooling down", () => {
    const pool = new TokenPool(writePool([{ accessToken: "a" }]), { cooldownMs: 60_000 });
    pool.load();
    pool.markFailure({ accessToken: "a" }, "boom");
    assert.equal(pool.status().healthy, 0);
    assert.equal(pool.next().accessToken, "a");
  });

  it("reads expiry out of the JWT and flags expired accounts", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;
    assert.equal(jwtExpiryMs(jwt(past)), past * 1000);
    assert.equal(jwtExpiryMs("not-a-jwt"), null);

    const pool = new TokenPool(writePool([{ accessToken: jwt(past) }, { accessToken: jwt(future) }]));
    pool.load();
    const status = pool.status();
    assert.equal(status.healthy, 1);
    assert.equal(status.accounts[0].expired, true);
    assert.equal(status.accounts[1].expired, false);
  });

  it("explains a missing token file", () => {
    const missing = path.join(os.tmpdir(), `sand2api-missing-${Date.now()}.json`);
    const pool = new TokenPool(missing);
    assert.throws(() => pool.load(), /TOKEN_FILE not found/);
  });

  it("does not fall back to an expired JWT", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const pool = new TokenPool(writePool([{ accessToken: jwt(past) }]));
    pool.load();
    assert.equal(pool.status().healthy, 0);
    assert.equal(pool.next(), null);
  });

  it("rejects a placeholder-only token file", () => {
    const pool = new TokenPool(writePool([{ accessToken: "your-cursor-access-token-here" }]));
    assert.throws(() => pool.load(), /no usable sand JWT or crsr_ apiKey/);
  });

  it("loads official crsr_ keys next to sand JWTs", () => {
    const pool = new TokenPool(
      writePool([
        { name: "sand", accessToken: "jwt-a" },
        { name: "sdk", kind: "api", apiKey: "crsr_abc" },
      ])
    );
    pool.load();
    assert.equal(pool.accounts.length, 2);
    assert.equal(pool.accounts[0].kind, "sand");
    assert.equal(pool.accounts[1].kind, "api");
    assert.equal(pool.status().accounts[1].kind, "api");
  });

  it("next(kind) stays inside one pool", () => {
    const pool = new TokenPool(
      writePool([{ accessToken: "jwt-a" }, { kind: "api", apiKey: "crsr_abc" }])
    );
    pool.load();
    assert.equal(pool.next("api").kind, "api");
    assert.equal(pool.next("sand").kind, "sand");
    assert.equal(pool.next("api").apiKey, "crsr_abc");
  });

  it("markKindFailure benches every sand JWT on a shared 429", () => {
    const pool = new TokenPool(writePool([{ accessToken: "a" }, { accessToken: "b" }]));
    pool.load();
    pool.markKindFailure("sand", "429", 20_000);
    assert.equal(pool.status().healthy, 0);
    assert.equal(pool.hasReady("sand"), false);
  });

  it("penalize on 429 does not bench any account, even if cooldown is configured", () => {
    assert.equal(config.tokens.rateLimitCooldownMs, 0);
    const pool = new TokenPool(writePool([{ accessToken: "a" }, { accessToken: "b" }]));
    pool.load();
    const token = pool.accounts[0];
    const failure = penalize(pool, token, "RATE_LIMIT_EXCEEDED", "kimi-k3", false, {
      protocol,
      accountModels: {
        disable() {
          throw new Error("429 must not disable or bench");
        },
      },
      config: { tokens: { rateLimitCooldownMs: 20_000, authCooldownMs: 0 } },
    });
    assert.equal(failure.status, 429);
    assert.equal(protocol.shouldFailover(failure), false);
    assert.equal(pool.status().healthy, 2);
    assert.equal(pool.hasReady("sand"), true);
  });

  it("sendHttpFailure omits Retry-After when rateLimitCooldownMs is 0", () => {
    const headers = {};
    let status = 0;
    const res = {
      headersSent: false,
      setHeader(k, v) {
        headers[k] = v;
      },
      status(code) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    };
    sendHttpFailure(
      res,
      { status: 429, message: "rate limited", type: "rate_limit_error", code: "rate_limit_exceeded" },
      { config, converter }
    );
    assert.equal(status, 429);
    assert.equal(headers["Retry-After"], undefined);
  });

  it("sendHttpFailure sets Retry-After only when rateLimitCooldownMs > 0", () => {
    const headers = {};
    const res = {
      headersSent: false,
      setHeader(k, v) {
        headers[k] = v;
      },
      status() {
        return this;
      },
      json() {
        return this;
      },
    };
    sendHttpFailure(
      res,
      { status: 429, message: "rate limited", type: "rate_limit_error", code: "rate_limit_exceeded" },
      { config: { tokens: { rateLimitCooldownMs: 20_000 } }, converter }
    );
    assert.equal(headers["Retry-After"], "20");
  });

  it("default cooldown of 0 keeps both accounts healthy after a failure", () => {
    const pool = new TokenPool(writePool([{ accessToken: "a" }, { accessToken: "b" }]));
    pool.load();
    pool.markFailure({ accessToken: "a" }, "429");
    assert.equal(pool.status().healthy, 2);
    assert.equal(pool.next().accessToken, "a");
    assert.equal(pool.next().accessToken, "b");
  });

  it("keeps cooldown state across a reload", () => {
    const file = writePool([{ accessToken: "a" }, { accessToken: "b" }]);
    const pool = new TokenPool(file, { cooldownMs: 60_000 });
    pool.load();
    pool.markFailure({ accessToken: "a" }, "429");
    fs.writeFileSync(file, JSON.stringify({ tokens: [{ accessToken: "a" }, { accessToken: "b" }, { accessToken: "c" }] }));
    pool.load();
    assert.equal(pool.accounts.length, 3);
    assert.equal(pool.status().healthy, 2);
  });
});

describe("usage mapping", () => {
  it("reports cache and reasoning tokens when the turn carries them", () => {
    const usage = protocol.usageFrom({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 5,
      reasoningTokens: 12,
    });
    assert.equal(usage.total_tokens, 120);
    assert.deepEqual(usage.prompt_tokens_details, { cached_tokens: 80, cache_creation_tokens: 5 });
    assert.deepEqual(usage.completion_tokens_details, { reasoning_tokens: 12 });
    // Not a top-level key: a relay summing usage fields would double-count it.
    assert.equal(usage.cache_creation_input_tokens, undefined);
  });

  it("omits the detail blocks when the turn has none", () => {
    const usage = protocol.usageFrom({ inputTokens: 3, outputTokens: 4 });
    assert.deepEqual(usage, { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
  });
});
