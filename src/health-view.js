function publicHealth({ version, tokens }) {
  const healthy = tokens && typeof tokens.healthy === "number" ? tokens.healthy : 0;
  const total = tokens && typeof tokens.total === "number" ? tokens.total : 0;
  return {
    status: healthy > 0 ? "ok" : "degraded",
    version: version || "",
    tokens: { total, healthy },
  };
}

function stripUsagePii(usage) {
  if (!usage || typeof usage !== "object") return usage;
  const copy = { ...usage };
  if (copy.onDemandSettings && typeof copy.onDemandSettings === "object") {
    const rest = { ...copy.onDemandSettings };
    delete rest.dashboardUrl;
    copy.onDemandSettings = rest;
  }
  return copy;
}

module.exports = { publicHealth, stripUsagePii };
