// Sand AgentService wants variant ids (`kimi-k3-max`). The official SDK wants
// the base id plus parameter values (`kimi-k3` + reasoning=max).
// Official models are advertised and requested with an `api-` prefix so a
// caller can tell the two pools apart.

const { collapseIds, dottedAliases, familyId, resolveOpenAIModel, typicalSlugs } = require("./model-family");

const OFFICIAL_PREFIX = "api-";

function parseRequestedModel(modelId) {
  const raw = String(modelId || "").trim();
  const official = raw.toLowerCase().startsWith(OFFICIAL_PREFIX);
  const rest = official ? raw.slice(OFFICIAL_PREFIX.length) : raw;
  return { official, rest, raw };
}

function prefixOfficialId(id) {
  const s = String(id || "").trim();
  if (!s) return s;
  if (s.toLowerCase().startsWith(OFFICIAL_PREFIX)) return s;
  return OFFICIAL_PREFIX + s;
}

function variantAliases(id) {
  if (id === "kimi-k3") return ["kimi-k3-low", "kimi-k3-high", "kimi-k3-max"];
  if (id === "grok-4.6") {
    return ["cursor-grok-4.6-high", "grok-4.6-high", "grok-4.6-low", "grok-4.6-xhigh"];
  }
  return [];
}

function prefixOfficialUsable(raw) {
  const seen = new Set();
  const models = [];
  const names = [];
  for (const m of (raw && raw.models) || []) {
    const base = m.name || m.id || m.modelId;
    if (base && base !== "default") names.push(base);
  }
  for (const fam of collapseIds(names)) {
    const id = prefixOfficialId(fam);
    if (seen.has(id)) continue;
    seen.add(id);
    const aliases = [...variantAliases(fam), ...dottedAliases(fam)]
      .map(prefixOfficialId)
      .filter((a) => a && a !== id);
    models.push({
      name: id,
      displayName: fam,
      aliases: [...new Set(aliases)],
    });
  }
  return { models };
}

function kimiReasoning(effort, fromSuffix) {
  const v = String(effort || fromSuffix || "max").toLowerCase();
  if (v === "max" || v === "xhigh" || v === "highest") return "max";
  if (v === "high" || v === "medium" || v === "default") return "high";
  return "low";
}

function grokEffort(effort, fromSuffix) {
  const v = String(effort || fromSuffix || "xhigh").toLowerCase();
  if (v === "max" || v === "xhigh" || v === "highest") return "xhigh";
  if (v === "high") return "high";
  if (v === "medium" || v === "default") return "medium";
  return "low";
}

function fableTier(effort, fromSuffix) {
  const v = String(effort || fromSuffix || "max").toLowerCase();
  if (v === "max" || v === "highest") return "max";
  if (v === "xhigh") return "xhigh";
  if (v === "high") return "high";
  if (v === "medium" || v === "default") return "medium";
  if (v === "low") return "low";
  return "max";
}

function applyEffortToSandId(modelId, effort) {
  const family = familyId(modelId);
  const resolved = resolveOpenAIModel(modelId, effort ? { reasoning_effort: effort } : {}, {
    usable: typicalSlugs(family),
  });
  if (resolved.error) return family;
  return resolved.slug;
}

function officialSelection(modelId, effort) {
  const raw = parseRequestedModel(modelId).rest;
  const off = effort != null && String(effort).trim().toLowerCase() === "none";
  if (!raw) {
    if (off) return { id: "kimi-k3", params: [] };
    return { id: "kimi-k3", params: [{ id: "reasoning", value: kimiReasoning(effort, "max") }] };
  }

  const kimi = raw.match(/^kimi-k3(?:-(low|high|max))?$/i);
  if (kimi) {
    if (off) return { id: "kimi-k3", params: [] };
    return {
      id: "kimi-k3",
      params: [{ id: "reasoning", value: kimiReasoning(effort, kimi[1] || "max") }],
    };
  }

  let id = raw;
  const params = [];
  let fast = false;
  if (id.endsWith("-fast")) {
    fast = true;
    id = id.slice(0, -5);
  }
  const grok = id.match(/^cursor-grok-4\.6(?:-(low|medium|high|xhigh))?$/i);
  if (grok || id === "grok-4.6") {
    if (!off) params.push({ id: "effort", value: grokEffort(effort, grok && grok[1]) });
    params.push({ id: "fast", value: "true" });
    return { id: "grok-4.6", params };
  }

  if (id.startsWith("cursor-")) id = id.slice("cursor-".length);
  if (fast) params.push({ id: "fast", value: "true" });
  if (effort && !off) {
    const v = String(effort).toLowerCase();
    params.unshift({ id: "effort", value: grokEffort(v) });
  }
  return { id, params };
}

module.exports = {
  OFFICIAL_PREFIX,
  parseRequestedModel,
  prefixOfficialId,
  prefixOfficialUsable,
  variantAliases,
  officialSelection,
  applyEffortToSandId,
  kimiReasoning,
  grokEffort,
};
