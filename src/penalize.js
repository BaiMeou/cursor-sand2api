// Account penalty + HTTP error write. Kept out of server.js so the 429
// path can be tested without starting the listener.

function penalize(pool, token, rawError, modelId, official, { protocol, accountModels, config }) {
  const failure = protocol.classifyUpstreamError(rawError);
  if (failure.code === "model_quota_exhausted" && token && modelId) {
    accountModels.disable(token, modelId, official || token.kind === "api", failure.detail);
    return failure;
  }
  // Caller mistakes (bad model, content filter) must not bench the account.
  if (failure.status === 400 || failure.status === 499) return failure;
  if (failure.code === "unsupported_region") return failure;
  if (failure.code === "plan_restricted") {
    if (token && modelId && accountModels && typeof accountModels.disable === "function") {
      accountModels.disable(token, modelId, official || token.kind === "api", failure.detail || failure.message, {
        family: true,
      });
    }
    return failure;
  }
  if (failure.status === 401 || failure.status === 403) {
    pool.markFailure(token, failure.message, config.tokens.authCooldownMs);
  } else if (failure.status === 429) {
    // Shared Cursor usage — do not bench, even when rateLimitCooldownMs > 0.
    return failure;
  } else {
    pool.markFailure(token, failure.message);
  }
  return failure;
}

function sendHttpFailure(res, failure, { config, converter }) {
  if (res.headersSent) return;
  if (failure.status === 429 && config.tokens.rateLimitCooldownMs > 0) {
    const sec = Math.max(1, Math.ceil(config.tokens.rateLimitCooldownMs / 1000));
    res.setHeader("Retry-After", String(sec));
  }
  res
    .status(failure.status)
    .json(converter.buildErrorResponse(failure.message, failure.type, failure.code, failure));
}

module.exports = { penalize, sendHttpFailure };
