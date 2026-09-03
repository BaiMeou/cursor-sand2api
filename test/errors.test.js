const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const protocol = require("../src/openai-protocol");
const converter = require("../src/converter");
const { ChatStream } = require("../src/openai-sse");

function collect() {
  const chunks = [];
  return {
    chunks,
    res: {
      writableEnded: false,
      write(s) {
        chunks.push(s);
      },
      end() {
        this.writableEnded = true;
      },
    },
  };
}

function frames(chunks) {
  return chunks
    .join("")
    .split("\n\n")
    .map((l) => l.replace(/^data: /, "").trim())
    .filter((l) => l && l !== "[DONE]")
    .map((l) => JSON.parse(l));
}

describe("upstream error classification", () => {
  const cases = [
    ["Other Models usage limit reached", 429, "rate_limit_error"],
    ["RATE_LIMIT_EXCEEDED", 429, "rate_limit_error"],
    ["connect error: resource_exhausted", 429, "rate_limit_error"],
    ["NOT_LOGGED_IN", 401, "authentication_error"],
    ["upstream HTTP 401", 401, "authentication_error"],
    ["unauthenticated: The provider refused to serve this request based on the content", 400, "invalid_request_error"],
    ["RateLimitError: resource_exhausted", 429, "rate_limit_error"],
    ["You've hit your usage limit", 429, "rate_limit_error"],
    ["AuthenticationError: invalid api key", 401, "authentication_error"],
    ["MODEL_BLOCKED for this account", 403, "permission_error"],
    ["resource_exhausted: Error ERROR_UNSUPPORTED_REGION", 403, "permission_error"],
    ["resource_exhausted: Error ERROR_PRO_USER_RATE_LIMIT_EXCEEDED", 429, "rate_limit_error"],
    ["ERROR_RATE_LIMITED_CHANGEABLE: Free plans can only use Auto", 403, "permission_error"],
    ["This model provider is not supported in your region", 403, "permission_error"],
    ['Model name is not valid: "kimi-k3"', 400, "invalid_request_error"],
    ["MODEL_NOT_AVAILABLE", 400, "invalid_request_error"],
    ["permission_denied", 403, "permission_error"],
    ["POOL_EXHAUSTED", 503, "server_error"],
    ["Request aborted", 499, "api_error"],
    ["invalid_argument: Error", 400, "invalid_request_error"],
    ["something nobody has seen", 502, "api_error"],
    ["input_token_limit: too long", 400, "invalid_request_error"],
    ["output_token_limit", 400, "invalid_request_error"],
    ["overloaded: try later", 503, "api_error"],
  ];

  for (const [raw, status, type] of cases) {
    it(`maps ${JSON.stringify(raw)} to ${status}`, () => {
      const f = protocol.classifyUpstreamError(raw);
      assert.equal(f.status, status);
      assert.equal(f.type, type);
      assert.equal(typeof f.code, "string");
    });
  }

  it("tells the operator how to unblock a blocked model", () => {
    const f = protocol.classifyUpstreamError("MODEL_BLOCKED");
    assert.equal(f.code, "model_blocked");
    assert.match(f.message, /MODEL_BLOCKED/);
    assert.match(f.hint, /Cursor dashboard/);
  });

  it("does not treat a content refusal as a dead credential", () => {
    const f = protocol.classifyUpstreamError(
      "unauthenticated: The provider refused to serve this request based on the content"
    );
    assert.equal(f.status, 400);
    assert.equal(f.code, "content_filter");
    assert.match(f.message, /based on the content/i);
    assert.match(f.hint, /content policy/i);
    assert.match(f.detail, /unauthenticated/i);
  });

  it("returns the real quota text and redacts dollar amounts", () => {
    const f = protocol.classifyUpstreamError("You've hit your usage limit You've saved $3389");
    assert.equal(f.status, 429);
    assert.equal(f.code, "model_quota_exhausted");
    assert.match(f.message, /hit your usage limit/i);
    assert.equal(f.message.includes("$3389"), false);
    assert.match(f.message, /\$…/);
  });

  it("falls back to 502 for an empty message", () => {
    assert.equal(protocol.classifyUpstreamError("").status, 502);
    assert.equal(protocol.classifyUpstreamError(undefined).status, 502);
  });

  it("classifies an InferenceStreamError object by error_type", () => {
    const f = protocol.classifyUpstreamError({
      errorType: 2,
      message: "prompt too large",
      isInputTokenLimitError: true,
    });
    assert.equal(f.status, 400);
    assert.equal(f.code, "context_length_exceeded");
    const rate = protocol.classifyUpstreamError({ errorType: 4, code: "RATE_LIMIT" });
    assert.equal(rate.status, 429);
  });

  it("keeps SuperGrok Pro rate-limit distinct from weekly quota", () => {
    const f = protocol.classifyUpstreamError({
      code: "resource_exhausted",
      message: "Error",
      details: [
        {
          debug: {
            error: "ERROR_PRO_USER_RATE_LIMIT_EXCEEDED",
            details: { title: "Rate limit exceeded.", detail: "Please wait a bit.", analyticsMetadata: { actionRequired: "upgrade" } },
          },
        },
      ],
    });
    assert.equal(f.status, 429);
    assert.equal(f.code, "pro_rate_limit");
    assert.match(f.message, /ERROR_PRO_USER_RATE_LIMIT_EXCEEDED/);
    assert.equal(f.actionRequired, "upgrade");
    assert.equal(protocol.shouldFailover(f), false);
  });

  it("does not treat an Anthropic region block as quota", () => {
    const f = protocol.classifyUpstreamError({
      code: "resource_exhausted",
      message: "Error",
      details: [
        {
          type: "aiserver.v1.ErrorDetails",
          debug: {
            error: "ERROR_UNSUPPORTED_REGION",
            details: {
              title: "Model not available",
              detail: "This model provider is not supported in your region.",
            },
          },
        },
      ],
    });
    assert.equal(f.status, 403);
    assert.equal(f.code, "unsupported_region");
    assert.match(f.message, /ERROR_UNSUPPORTED_REGION/);
    assert.match(f.message, /not supported in your region/);
    assert.equal(f.cursorError, "ERROR_UNSUPPORTED_REGION");
    assert.equal(protocol.shouldFailover(f), false);
  });

  it("does not failover a 429 onto the other sand JWT", () => {
    const rate = protocol.classifyUpstreamError("resource_exhausted");
    const quota = protocol.classifyUpstreamError("You've hit your usage limit");
    assert.equal(protocol.shouldFailover(rate), false);
    assert.equal(protocol.shouldFailover(quota), false);
    assert.equal(protocol.shouldFailover(protocol.classifyUpstreamError("Request aborted")), false);
    assert.equal(protocol.shouldFailover(protocol.classifyUpstreamError("overloaded: try later")), true);
    const poolEmpty = protocol.classifyUpstreamError("POOL_EXHAUSTED");
    assert.equal(poolEmpty.code, "pool_exhausted");
    assert.equal(protocol.shouldFailover(poolEmpty), false);
  });
});

describe("stream error frames", () => {
  it("emits a top-level error object, never a clean stop", () => {
    const { chunks, res } = collect();
    const s = new ChatStream(res, { model: "kimi-k3-max" });
    s.role();
    s.content("half an ans");
    s.error("Other Models usage limit reached", "rate_limit_error", "rate_limit_exceeded");

    const parsed = frames(chunks);
    const error = parsed.find((f) => f.error);
    assert.ok(error, "an error frame must be present");
    assert.equal(error.error.type, "rate_limit_error");
    assert.equal(error.error.code, "rate_limit_exceeded");

    const finished = parsed.filter((f) => f.choices && f.choices[0] && f.choices[0].finish_reason);
    assert.deepEqual(finished, [], "a failed turn must not carry a finish_reason");
    assert.match(chunks.join(""), /data: \[DONE\]/);
  });

  it("ignores a second terminal write", () => {
    const { chunks, res } = collect();
    const s = new ChatStream(res, { model: "m" });
    s.error("boom");
    const before = chunks.length;
    s.error("boom again");
    s.finish("stop");
    assert.equal(chunks.length, before);
  });

  it("still finishes cleanly on success, with usage on the finish chunk", () => {
    const { chunks, res } = collect();
    const s = new ChatStream(res, { model: "m" });
    s.role();
    s.content("pong");
    s.finish("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
    const parsed = frames(chunks);
    assert.equal(parsed.some((f) => f.error), false);
    const finish = parsed.find((f) => f.choices && f.choices[0] && f.choices[0].finish_reason);
    assert.equal(finish.choices[0].finish_reason, "stop");
    assert.equal(finish.usage.total_tokens, 2);
  });

  it("sends content on the role frame for clients that index it unguarded", () => {
    const { chunks, res } = collect();
    new ChatStream(res, { model: "m" }).role();
    assert.equal(frames(chunks)[0].choices[0].delta.content, "");
  });
});

describe("upstream error detail extraction", () => {
  const { errorDetail } = require("../src/cursor-client");

  it("reads the debug object connect+json actually sends", () => {
    const detail = errorDetail({
      code: "not_found",
      message: "Error",
      details: [
        {
          type: "aiserver.v1.ErrorDetails",
          debug: {
            error: "ERROR_BAD_MODEL_NAME",
            details: { title: "AI Model Not Found", detail: 'Model name is not valid: "grok-4.6"' },
          },
        },
      ],
    });
    assert.match(detail, /ERROR_BAD_MODEL_NAME/);
    assert.match(detail, /Model name is not valid/);
    // And that has to classify as the caller's mistake, not ours.
    assert.equal(protocol.classifyUpstreamError(detail).status, 400);
  });

  it("reads a Connect region trailer so it does not classify as quota", () => {
    const detail = errorDetail({
      code: "resource_exhausted",
      message: "Error",
      details: [
        {
          debug: {
            error: "ERROR_UNSUPPORTED_REGION",
            details: { detail: "This model provider is not supported in your region." },
          },
        },
      ],
    });
    assert.match(detail, /ERROR_UNSUPPORTED_REGION/);
    assert.equal(protocol.classifyUpstreamError(detail).code, "unsupported_region");
  });

  it("still decodes the base64 form when that is what arrives", () => {
    const value = Buffer.from("RATE_LIMIT hit", "utf8").toString("base64");
    assert.equal(errorDetail({ message: "Error", details: [{ value }] }), "RATE_LIMIT hit");
  });

  it("falls back to message, then code", () => {
    assert.equal(errorDetail({ message: "plain failure" }), "plain failure");
    assert.equal(errorDetail({ code: "unavailable" }), "unavailable");
    assert.equal(errorDetail(null), "Unknown error");
  });
});

describe("error response body", () => {
  it("uses a string code", () => {
    const body = converter.buildErrorResponse("nope", "rate_limit_error", "rate_limit_exceeded");
    assert.equal(typeof body.error.code, "string");
    assert.equal(body.error.type, "rate_limit_error");
  });

  it("surfaces the Cursor debug fields for operators", () => {
    const failure = protocol.classifyUpstreamError({
      code: "resource_exhausted",
      message: "Error",
      details: [
        {
          debug: {
            error: "ERROR_UNSUPPORTED_REGION",
            details: {
              title: "Model not available",
              detail: "This model provider is not supported in your region.",
              isRetryable: false,
              analyticsMetadata: { actionRequired: "change_model" },
            },
          },
        },
      ],
    });
    failure.account = "qq@example.com";
    failure.accountKind = "sand";
    failure.model = "claude-fable-5-1-thinking-high";
    const body = converter.buildErrorResponse(failure.message, failure.type, failure.code, failure);
    assert.match(body.error.message, /ERROR_UNSUPPORTED_REGION/);
    assert.equal(body.error.cursor_error, "ERROR_UNSUPPORTED_REGION");
    assert.equal(body.error.action_required, "change_model");
    assert.equal(body.error.account, undefined);
    assert.equal(body.error.account_kind, undefined);
    assert.equal(body.error.model, "claude-fable-5-1-thinking-high");
    assert.equal(body.error.retryable, false);
  });
});
