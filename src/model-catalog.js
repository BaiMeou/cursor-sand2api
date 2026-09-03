// Reasoning depth is a real upstream parameter, not a prompt hint: every
// AgentRunRequest carries `requestedModel.parameters`, a list of {id, value}
// pairs the backend applies to the model itself.
//
// The catch is that the id is per model family — claude and grok publish
// `effort`, the gpt and kimi lines publish `reasoning`, and several models
// publish neither. Cursor rejects the whole request when it sees an id the
// target model never declared, so a wrong guess costs the turn, not just the
// setting. Nothing here is ever guessed: a parameter is sent only when this
// account's model catalog says the model declares it, and only with a value the
// catalog lists for it. No catalog means no parameters.

// Weakest to strongest. Callers spell the same intent several ways and each
// family publishes its own subset, so a request is mapped onto this ladder
// first and clamped onto what the target model actually offers second.
const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Spellings that are not ladder rungs of their own. `minimal` stays in the
// ladder above because a model may publish it as a value even though a caller
// asking for it means `low`.
const EFFORT_ALIASES = { minimal: "low", default: "medium", highest: "max" };

// Anthropic states the same intent as a token budget. LiteLLM emits 1024/2048/
// 4096 for the low/medium/high a Codex client can select, so anything past the
// medium cutoff means "as much as this model offers".
const EFFORT_BUDGETS = [
  [1024, "low"],
  [2048, "medium"],
];

// Tried in order; the first id the model declares takes the value and the rest
// are skipped, because a model listing both still wants one setting.
const EFFORT_PARAM_IDS = ["effort", "reasoning"];

const DEFAULT_TTL_MS = 15 * 60 * 1000;
// A network blip at startup must not pin the process to the fallback set for a
// whole TTL, so a failed fetch is remembered far more briefly than a good one.
const DEFAULT_ERROR_TTL_MS = 60 * 1000;

function str(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

function names(v) {
  return list(v).map(str).filter(Boolean);
}

// The catalog message is only known from reverse engineering, and a JSON codec
// spells its fields lowerCamelCase where proto text spells them snake_case, so
// every lookup accepts both plus the shape the agent RPC uses.
function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function optionValue(opt) {
  if (opt && typeof opt === "object") return str(pick(opt, "value"));
  return str(opt);
}

// The live catalog nests the options one level deeper than the field numbers
// suggest — verified 2026-08-30 against api2.cursor.sh:
//   { id: "effort",
//     parameterType: { enumParameter: { values: [{ value: "low", displayName: "Low" }, …] } } }
//   { id: "fast",
//     parameterType: { booleanParameter: { values: [{ value: "false" }, …] } } }
// The flatter shapes are kept as fallbacks so an older or newer generation of
// the message still yields values rather than silently none.
const VALUE_GROUPS = [
  "enumParameter",
  "enum_parameter",
  "booleanParameter",
  "boolean_parameter",
  "enumOptions",
  "enum_options",
  "boolOptions",
  "bool_options",
];

function parseParamValues(raw) {
  if (Array.isArray(raw)) return raw.map(optionValue).filter(Boolean);
  if (!raw || typeof raw !== "object") return [];
  const out = [];
  const add = (opt) => {
    const value = optionValue(opt);
    if (value && !out.includes(value)) out.push(value);
  };

  for (const key of VALUE_GROUPS) {
    const group = raw[key];
    if (!group) continue;
    if (Array.isArray(group)) group.forEach(add);
    else list(pick(group, "values", "options")).forEach(add);
  }
  if (!out.length) list(pick(raw, "values", "options")).forEach(add);
  return out;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const params = {};
  const declared = entry.params && typeof entry.params === "object" ? entry.params : {};
  for (const [id, values] of Object.entries(declared)) {
    const allowed = names(values);
    // A definition whose values could not be read is dropped rather than kept
    // empty: there is no value left to send that the model is known to accept.
    if (allowed.length) params[id] = allowed;
  }
  // Lookups renormalize whatever is in the table, so this has to read its own
  // output as happily as it reads the raw catalog.
  const variants = [];
  for (const variant of list(entry.variants)) {
    if (!variant || typeof variant !== "object") continue;
    const slug = str(pick(variant, "slug", "legacySlug", "legacy_slug"));
    const isDefault = Boolean(
      pick(variant, "isDefault", "isDefaultNonMaxConfig", "is_default_non_max_config")
    );
    const values = {};
    const already = variant.params && typeof variant.params === "object" ? variant.params : null;
    if (already) {
      for (const [id, value] of Object.entries(already)) {
        if (id && str(value)) values[id] = str(value);
      }
    }
    for (const pv of list(pick(variant, "parameterValues", "parameter_values", "parameters"))) {
      const id = str(pick(pv, "id"));
      const value = str(pick(pv, "value"));
      if (id && value) values[id] = value;
    }
    if (slug || Object.keys(values).length) variants.push({ slug, isDefault, params: values });
  }

  return {
    params,
    variants,
    aliases: names(entry.aliases),
    legacySlugs: names(entry.legacySlugs),
  };
}

// Catalog response -> { [modelId]: { params, aliases, legacySlugs } }.
function parseCatalog(raw) {
  const table = {};
  const models = Array.isArray(raw) ? raw : list(pick(raw, "models"));
  for (const model of models) {
    if (!model || typeof model !== "object") continue;
    const id = str(pick(model, "name", "modelId", "model_id", "id"));
    // "default" is a picker placeholder, not something a caller can request.
    if (!id || id === "default") continue;
    const params = {};
    for (const def of list(pick(model, "parameterDefinitions", "parameter_definitions"))) {
      const paramId = str(pick(def, "id"));
      if (!paramId) continue;
      const values = parseParamValues(
        pick(def, "parameterType", "parameter_type", "values", "parameterValues", "parameter_values")
      );
      if (values.length) params[paramId] = values;
    }
    table[id] = normalizeEntry({
      params,
      variants: pick(model, "variants"),
      aliases: pick(model, "idAliases", "id_aliases", "aliases"),
      legacySlugs: pick(model, "legacySlugs", "legacy_slugs"),
    });
  }
  return table;
}

function normalizeTable(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, entry] of Object.entries(raw)) {
    const normalized = normalizeEntry(entry);
    if (normalized) out[id] = normalized;
  }
  return out;
}

// The level the caller asked for, in ladder terms, or null when they asked for
// nothing. OpenAI, the newer `reasoning` block and Anthropic's `thinking` block
// all state the same intent differently.
function normalizeEffort(body) {
  const src = body && typeof body === "object" ? body : {};
  const reasoning = src.reasoning && typeof src.reasoning === "object" ? src.reasoning : {};
  const thinking = src.thinking && typeof src.thinking === "object" ? src.thinking : {};
  const named = str(pick(src, "reasoning_effort")) || str(pick(reasoning, "effort")) || str(pick(thinking, "effort"));
  const level = named.trim().toLowerCase();
  if (level) return EFFORT_ALIASES[level] || level;

  const budget = pick(thinking, "budget_tokens", "budgetTokens");
  if (budget === undefined || budget === "") return null;
  const tokens = Number(budget);
  if (!Number.isFinite(tokens)) return null;
  for (const [cutoff, name] of EFFORT_BUDGETS) {
    if (tokens <= cutoff) return name;
  }
  return "max";
}

// The published level closest to the one asked for, or null when the model
// publishes nothing comparable. Sending a level verbatim fails the request.
function nearestEffort(want, allowed) {
  const level = str(want).trim().toLowerCase();
  const options = names(allowed);
  const exact = options.find((v) => v.toLowerCase() === level);
  if (exact) return exact;

  const target = EFFORT_LADDER.indexOf(level);
  if (target < 0) return null;
  let best = null;
  let bestAt = -1;
  let bestDistance = Infinity;
  for (const option of options) {
    const at = EFFORT_LADDER.indexOf(option.toLowerCase());
    if (at < 0) continue;
    const distance = Math.abs(at - target);
    if (distance > bestDistance) continue;
    // Ties go to the stronger rung: the caller asked for more thinking.
    if (distance === bestDistance && at < bestAt) continue;
    best = option;
    bestAt = at;
    bestDistance = distance;
  }
  return best;
}

// A caller may name the model by a spelling the catalog carries as an alias or
// a legacy slug. Those belong to the same model, so its parameters apply.
function findEntry(modelId, catalog) {
  const found = locate(modelId, catalog);
  return found ? found.entry : null;
}

// Also reports which base model the name belongs to and, when the name was a
// variant slug, the parameters that slug stands for.
function locate(modelId, catalog) {
  const id = str(modelId).trim();
  if (!id || !catalog || typeof catalog !== "object") return null;
  const low = id.toLowerCase();

  const direct = normalizeEntry(catalog[id]);
  if (direct) return { modelId: id, entry: direct, implied: {} };

  for (const key of Object.keys(catalog)) {
    const entry = normalizeEntry(catalog[key]);
    if (!entry) continue;
    if (key.toLowerCase() === low || entry.aliases.some((a) => a.toLowerCase() === low)) {
      return { modelId: key, entry, implied: {} };
    }
    const variant = entry.variants.find((v) => v.slug && v.slug.toLowerCase() === low);
    if (variant) return { modelId: key, entry, implied: variant.params };
    if (entry.legacySlugs.some((s) => s.toLowerCase() === low)) {
      return { modelId: key, entry, implied: {} };
    }
  }
  return null;
}

// Which model id to actually send for what the caller asked for.
//
// Reasoning depth is a real parameter in the catalog, but not on this transport:
// verified 2026-08-30 against api2.cursor.sh with client-type sand, the base id
// `kimi-k3` comes back `not_found` whether or not requestedModel.parameters is
// set, while the variant slugs `kimi-k3-low` / `-high` / `-max` all run. So the
// depth has to be chosen by naming the right variant.
//
// Returns the caller's name untouched whenever the catalog cannot back the
// request, which is exactly how this behaved before the catalog existed.
function resolveModel(modelId, body, catalog) {
  const requested = str(modelId).trim();
  const found = locate(requested, catalog);
  if (!found) return { modelId: requested, effort: null };

  const low = requested.toLowerCase();
  const asSlug = found.entry.variants.find((v) => v.slug && v.slug.toLowerCase() === low);

  const level = normalizeEffort(body);
  if (!level) {
    // Already a routable variant name.
    if (asSlug) return { modelId: requested, effort: null };
    // A base id or an alias is not routable on its own, so stand in the variant
    // the catalog marks as this model's default.
    const fallback =
      found.entry.variants.find((v) => v.isDefault && v.slug) ||
      found.entry.variants.find((v) => v.slug);
    return { modelId: fallback ? fallback.slug : requested, effort: null };
  }

  const paramId = EFFORT_PARAM_IDS.find((id) => (found.entry.params[id] || []).length);
  if (!paramId) return { modelId: requested, effort: null };
  const value = nearestEffort(level, found.entry.params[paramId]);
  if (!value) return { modelId: requested, effort: null };

  const variant = found.entry.variants.find((v) => v.slug && v.params[paramId] === value);
  if (!variant) return { modelId: requested, effort: null };
  return { modelId: variant.slug, effort: value };
}

// Parameters to put on requestedModel for this request, as [{id, value}].
// Empty whenever the model is unknown, declares no reasoning parameter, or
// publishes nothing close to what was asked for.
function resolveModelParams(modelId, body, catalog) {
  const entry = findEntry(modelId, catalog);
  if (!entry) return [];
  const level = normalizeEffort(body);
  if (!level) return [];
  for (const id of EFFORT_PARAM_IDS) {
    const allowed = entry.params[id];
    if (!allowed || !allowed.length) continue;
    const value = nearestEffort(level, allowed);
    return value ? [{ id, value }] : [];
  }
  return [];
}

function catalogRequestBody() {
  // useModelParameters is the switch: without it the response carries 207
  // models and not one parameter definition. Verified 2026-08-30.
  return { includeLongContextModels: true, useModelParameters: true, doNotUseMarkdown: true };
}

// Cached catalog manager. The fetch is injected so the parsing and clamping
// above stay testable without a network, and so the caller owns transport,
// credentials and token rotation.
function createCatalog({
  fetchCatalog,
  ttlMs = DEFAULT_TTL_MS,
  errorTtlMs = DEFAULT_ERROR_TTL_MS,
  fallback,
} = {}) {
  const fallbackTable = normalizeTable(fallback);
  let upstream = null;
  let table = null;
  let source = "none";
  let error = null;
  let fetchedAt = 0;
  let expiresAt = 0;
  let inflight = null;

  async function load() {
    try {
      const parsed = parseCatalog(await fetchCatalog());
      // An empty catalog is indistinguishable from a request the server parsed
      // but ignored, so it counts as a failure: keep whatever still works and
      // come back in a minute rather than pinning nothing for the full TTL.
      if (!Object.keys(parsed).length) throw new Error("catalog listed no models");
      upstream = parsed;
      table = parsed;
      source = "upstream";
      error = null;
      expiresAt = Date.now() + ttlMs;
    } catch (e) {
      error = (e && e.message) || String(e);
      // A catalog that worked five minutes ago beats the built-in guess.
      table = upstream || fallbackTable;
      source = upstream ? "stale" : "fallback";
      expiresAt = Date.now() + errorTtlMs;
    }
    fetchedAt = Date.now();
    return table;
  }

  function ensure(force) {
    if (!force && table && Date.now() < expiresAt) return Promise.resolve(table);
    if (!inflight) {
      inflight = load().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    // With an id: that model's entry, or null. Without one: the whole table,
    // which is what resolveModelParams takes.
    async get(modelId) {
      const current = await ensure(false);
      return modelId === undefined ? current : findEntry(modelId, current);
    },
    refresh() {
      return ensure(true);
    },
    status() {
      const ids = table ? Object.keys(table) : [];
      return {
        source,
        models: ids.length,
        // Zero here on a non-empty catalog means the response carried no
        // parameter definitions, which is the signal that this transport cannot
        // drive reasoning depth at all.
        withParams: ids.filter((id) => Object.keys(table[id].params).length).length,
        fetchedAt,
        ageMs: fetchedAt ? Date.now() - fetchedAt : 0,
        expiresInMs: Math.max(0, expiresAt - Date.now()),
        error,
      };
    },
  };
}

module.exports = {
  parseCatalog,
  normalizeEffort,
  nearestEffort,
  resolveModel,
  resolveModelParams,
  catalogRequestBody,
  createCatalog,
  EFFORT_LADDER,
  EFFORT_ALIASES,
  EFFORT_BUDGETS,
};
