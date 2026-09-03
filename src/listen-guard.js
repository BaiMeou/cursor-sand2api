function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

function resolveWebUi(raw, host) {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "on" || v === "1" || v === "true" || v === "yes") return true;
  if (v === "off" || v === "0" || v === "false" || v === "no") return false;
  return isLoopbackHost(host);
}

function requireApiKeyForBind(apiKey, host) {
  if (apiKey) return null;
  if (isLoopbackHost(host)) return null;
  return "Set API_KEY before binding to a non-loopback address";
}

function corsOriginOption(corsOrigin, host) {
  const raw = String(corsOrigin || "").trim();
  if (raw === "*") return true;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return isLoopbackHost(host);
}

module.exports = { isLoopbackHost, resolveWebUi, requireApiKeyForBind, corsOriginOption };
