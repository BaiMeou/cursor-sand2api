// Cursor answers "which models are there" twice and neither answer is enough on
// its own. agent.v1.AgentService/GetUsableModels returns the names that actually
// run — 204 of them on 2026-08-30 — and little else. aiserver.v1.AiService/
// AvailableModels with an empty body returns 207 runnable names carrying
// capability flags, alias spellings and a tooltip blob, but it is the weaker
// authority on what this account may run. So the names come from the first and
// the decoration from the second, and either half may be missing.
//
// Everything below is pure; the two fetches are injected, exactly as in
// model-catalog.js, so the join stays testable without a network and the caller
// keeps transport, credentials and token rotation.

const { collapseEntries } = require("./model-family");

const DEFAULT_TTL_MS = 15 * 60 * 1000;
// A network blip at startup must not pin an empty list for a whole TTL, so a
// failed fetch is remembered far more briefly than a good one.
const DEFAULT_ERROR_TTL_MS = 60 * 1000;

// Both RPCs list it; it is the picker's "let Cursor choose" row, not a model.
const PLACEHOLDER = "default";

const OWNER = "cursor";

// The wire names and the OpenAI names for the same four flags, so a model object
// this module emitted can be read back through the same table it was written by.
const CAPABILITY_KEYS = [
  ["images", "supports_images"],
  ["thinking", "supports_thinking"],
  ["maxMode", "supports_max_mode"],
  ["agent", "supports_agent"],
];

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

// A JSON codec spells these fields lowerCamelCase where proto text spells them
// snake_case, and the two RPCs disagree on the name of the id, so every lookup
// accepts each spelling it might arrive under.
function pick(obj, ...keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function modelsOf(raw) {
  return Array.isArray(raw) ? raw : list(pick(raw, "models"));
}

function uniqueNames(values, exclude) {
  const out = [];
  for (const value of values) {
    if (!value || value === exclude || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

// Without useModelParameters the catalog states the window only in prose, inside
// the tooltip markdown: "…<br /><br />256k context window<br /><br />…". A bare
// number and a k suffix are the two forms observed; any other unit is left
// unparsed rather than guessed at, because a wrong window is worse for a caller
// than a missing one.
const CONTEXT_WINDOW_RE = /(\d[\d,]*)\s*([a-z]*)\s*context window/i;

function parseContextWindow(text) {
  const match = CONTEXT_WINDOW_RE.exec(str(text));
  if (!match) return null;
  const count = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(count) || count <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit === "k") return count * 1000;
  return unit ? null : count;
}

function contextWindowOf(model) {
  const declared = Number(pick(model, "contextTokenLimit", "context_token_limit"));
  if (Number.isFinite(declared) && declared > 0) return declared;
  const tooltip = pick(model, "tooltipData", "tooltip_data");
  return parseContextWindow(pick(tooltip, "markdownContent", "markdown_content"));
}

// One AvailableModels record -> the decoration a merged entry can carry.
function catalogMeta(model) {
  return {
    displayName:
      str(pick(model, "clientDisplayName", "client_display_name")) ||
      str(pick(model, "inputboxShortModelName", "inputbox_short_model_name")),
    aliases: names(pick(model, "idAliases", "id_aliases")),
    contextWindow: contextWindowOf(model),
    vendor: str(pick(model, "vendorName", "vendor_name", "vendor")),
    // Absent means false here: this is proto3 JSON, which drops every field
    // still sitting at its default, so kimi simply has no supportsImages key.
    capabilities: {
      images: Boolean(pick(model, "supportsImages", "supports_images")),
      thinking: Boolean(pick(model, "supportsThinking", "supports_thinking")),
      maxMode: Boolean(pick(model, "supportsMaxMode", "supports_max_mode")),
      agent: Boolean(pick(model, "supportsAgent", "supports_agent")),
    },
  };
}

// One GetUsableModels record -> the little it knows beyond the name.
function usableInfo(model) {
  return {
    displayName:
      str(pick(model, "displayName", "display_name")) ||
      str(pick(model, "displayNameShort", "display_name_short")),
    aliases: names(pick(model, "aliases")),
  };
}

function mergeEntry(id, fromUsable, fromCatalog) {
  const usable = fromUsable || {};
  const catalog = fromCatalog || {};
  return {
    id,
    displayName: usable.displayName || catalog.displayName || "",
    aliases: uniqueNames([...(usable.aliases || []), ...(catalog.aliases || [])], id),
    contextWindow: catalog.contextWindow || null,
    vendor: catalog.vendor || "",
    // A model the catalog never mentioned gets no flags at all, rather than four
    // falses that would claim it cannot do things nobody checked.
    capabilities: fromCatalog ? catalog.capabilities : null,
  };
}

function readCapabilities(entry) {
  if (entry.capabilities) return entry.capabilities;
  if (!CAPABILITY_KEYS.some(([, key]) => entry[key] !== undefined)) return null;
  const capabilities = {};
  for (const [name, key] of CAPABILITY_KEYS) capabilities[name] = Boolean(entry[key]);
  return capabilities;
}

// Accepts a merged entry, a model object this module already emitted, or a bare
// id. The second form matters because re-wrapping a list entry — which is the
// obvious way to answer /v1/models/:id — must not quietly drop its metadata.
function buildModelObject(entry, created) {
  const src = typeof entry === "string" ? { id: entry } : entry && typeof entry === "object" ? entry : {};
  const id = str(src.id);
  const model = {
    id,
    object: "model",
    created: Number.isFinite(created) ? created : Math.floor(Date.now() / 1000),
    owned_by: OWNER,
    // Deprecated by OpenAI, but this proxy has always emitted them and some
    // gateways still index root.
    permission: [],
    root: id,
    parent: null,
  };

  const displayName = str(src.displayName) || str(src.display_name);
  if (displayName) model.display_name = displayName;

  const contextWindow = Number(src.contextWindow ?? src.context_window);
  if (Number.isFinite(contextWindow) && contextWindow > 0) model.context_window = contextWindow;

  const capabilities = readCapabilities(src);
  if (capabilities) {
    for (const [name, key] of CAPABILITY_KEYS) model[key] = Boolean(capabilities[name]);
  }

  const vendor = str(src.vendor);
  if (vendor) model.vendor = vendor;

  const aliases = names(src.aliases);
  if (aliases.length) model.aliases = aliases;

  return model;
}

// Every catalog-backed entry carries the whole supports_* block, so one key is
// a faithful test for "this model's metadata was found".
function hasMetadata(model) {
  return Boolean(model) && model.supports_images !== undefined;
}

// The two responses joined into an OpenAI /v1/models body. Either argument may
// be null: with only the runnable names the list is bare but correct, and with
// only the catalog it is decorated but no longer vouched for by this account.
function buildModelList(usable, catalog, created) {
  const meta = new Map();
  for (const model of modelsOf(catalog)) {
    if (!model || typeof model !== "object") continue;
    const id = str(pick(model, "name", "serverModelName", "server_model_name", "modelId", "model_id", "id"));
    if (!id || id === PLACEHOLDER || meta.has(id)) continue;
    meta.set(id, catalogMeta(model));
  }

  const entries = [];
  const seen = new Set();
  function add(id, fromUsable) {
    if (!id || id === PLACEHOLDER || seen.has(id)) return;
    seen.add(id);
    entries.push(mergeEntry(id, fromUsable, meta.get(id) || null));
  }

  for (const model of modelsOf(usable)) {
    if (!model || typeof model !== "object") continue;
    add(str(pick(model, "modelId", "model_id", "name", "id")), usableInfo(model));
  }

  // The catalog names run too, but they are strictly a fallback: whenever the
  // authoritative list answered, it alone decides what this proxy advertises.
  if (!entries.length) {
    for (const id of meta.keys()) add(id, null);
  }

  const stamp = Number.isFinite(created) ? created : Math.floor(Date.now() / 1000);
  return { object: "list", data: collapseEntries(entries).map((entry) => buildModelObject(entry, stamp)) };
}

// A caller may name a model by whichever spelling their client showed them, so
// the published aliases resolve as well as the id itself.
function findModel(id, models) {
  const want = str(id).trim();
  if (!want) return null;
  const data = Array.isArray(models) ? models : list(pick(models, "data", "models"));

  const exact = data.find((model) => model && model.id === want);
  if (exact) return exact;

  const low = want.toLowerCase();
  for (const model of data) {
    if (!model || typeof model !== "object") continue;
    if (str(model.id).toLowerCase() === low) return model;
    if (names(model.aliases).some((alias) => alias.toLowerCase() === low)) return model;
  }
  return null;
}

// Cached list manager. The two fetches are independent on purpose: the runnable
// names alone make a serviceable list, and the catalog alone still beats
// answering nothing.
function createModelList({
  fetchUsable,
  fetchCatalog,
  ttlMs = DEFAULT_TTL_MS,
  errorTtlMs = DEFAULT_ERROR_TTL_MS,
} = {}) {
  let body = null;
  let source = "none";
  let error = null;
  let fetchedAt = 0;
  let expiresAt = 0;
  let inflight = null;

  async function attempt(fetcher, label) {
    if (typeof fetcher !== "function") return { ok: false, error: `${label}: no fetcher` };
    try {
      return { ok: true, value: await fetcher() };
    } catch (e) {
      return { ok: false, error: `${label}: ${(e && e.message) || String(e)}` };
    }
  }

  async function load() {
    const [usable, catalog] = await Promise.all([
      attempt(fetchUsable, "usable models"),
      attempt(fetchCatalog, "model catalog"),
    ]);
    fetchedAt = Date.now();
    const failures = [usable, catalog].filter((r) => !r.ok).map((r) => r.error);

    if (usable.ok || catalog.ok) {
      const built = buildModelList(usable.value, catalog.value);
      // An empty list is indistinguishable from a request the server parsed and
      // ignored, so it counts as a failure rather than being pinned for a TTL.
      if (built.data.length) {
        body = built;
        source = failures.length ? "partial" : "upstream";
        error = failures.length ? failures.join("; ") : null;
        expiresAt = fetchedAt + ttlMs;
        return body;
      }
      failures.push("upstream listed no models");
    }

    error = failures.join("; ");
    expiresAt = fetchedAt + errorTtlMs;
    // A list that worked ten minutes ago beats an error.
    if (body) {
      source = "stale";
      return body;
    }
    source = "none";
    throw new Error(error);
  }

  function ensure(force) {
    if (!force && Date.now() < expiresAt) {
      if (body) return Promise.resolve(body);
      // Nothing to serve and the short error window has not elapsed: fail fast
      // instead of hammering an upstream that just refused both halves.
      if (error) return Promise.reject(new Error(error));
    }
    if (!inflight) {
      inflight = load().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  return {
    list() {
      return ensure(false);
    },
    async find(id) {
      return findModel(id, await ensure(false));
    },
    refresh() {
      return ensure(true);
    },
    status() {
      const data = body ? body.data : [];
      return {
        source,
        models: data.length,
        // Short of models on a non-empty list means the catalog half failed, so
        // the list is names only.
        withMetadata: data.filter(hasMetadata).length,
        fetchedAt,
        ageMs: fetchedAt ? Date.now() - fetchedAt : 0,
        error,
      };
    },
  };
}

module.exports = {
  buildModelList,
  buildModelObject,
  findModel,
  parseContextWindow,
  createModelList,
};
