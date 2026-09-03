const fs = require("fs");
const { accountKey } = require("./token-pool");
const { parseRequestedModel, officialSelection } = require("./model-route");
const { familyCovers, familyId } = require("./model-family");

const PLACEHOLDER = "default";

function namesOf(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : raw.models || raw.items || raw.data || [];
  const ids = [];
  for (const m of list) {
    if (typeof m === "string") {
      ids.push(m);
      continue;
    }
    if (!m || typeof m !== "object") continue;
    const id = m.modelId || m.model_id || m.name || m.id || m.serverModelName;
    if (id) ids.push(String(id));
  }
  return ids.filter((id) => id && id !== PLACEHOLDER);
}

function stripOfficial(id) {
  return parseRequestedModel(id).rest;
}

// Does this account's allowlist contain the model the caller asked to run?
function modelCovered(ids, requested, official) {
  if (!ids || typeof ids.has !== "function") return true;
  if (ids.size === 0) return false;
  const parsed = parseRequestedModel(requested);
  const rest = parsed.rest || String(requested || "");
  if (official || parsed.official) {
    const sel = officialSelection(rest);
    return Boolean(sel && ids.has(sel.id));
  }
  if (ids.has(requested) || ids.has(rest)) return true;
  return familyCovers(ids, requested);
}

function canonicalId(requested, official) {
  const parsed = parseRequestedModel(requested);
  if (official || parsed.official) {
    const sel = officialSelection(parsed.rest);
    return (sel && sel.id) || parsed.rest;
  }
  return parsed.rest || String(requested || "");
}

function parseQuotaReset(raw) {
  const m = String(raw || "").match(/on\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 23, 59, 59);
  return Date.now() + 30 * 24 * 60 * 60 * 1000;
}

function createAccountModels({
  ttlMs = 15 * 60 * 1000,
  errorTtlMs = 30 * 1000,
  fetchSand,
  fetchOfficial,
  persistPath = "",
  verifyOfficial = null,
  verifyModels = ["kimi-k3"],
  log = () => {},
} = {}) {
  const cache = new Map();
  const disabled = new Map();
  const verified = new Set();

  function readPersist() {
    if (!persistPath || !fs.existsSync(persistPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(persistPath, "utf8"));
      const rows = raw && raw.disabled ? raw.disabled : {};
      for (const [key, models] of Object.entries(rows)) {
        const inner = new Map();
        for (const [id, row] of Object.entries(models || {})) {
          if (row && row.until && row.until > Date.now()) inner.set(id, row);
        }
        if (inner.size) disabled.set(key, inner);
      }
    } catch (e) {
      log(`disabled-models persist unreadable: ${e.message}`);
    }
  }

  function writePersist() {
    if (!persistPath) return;
    const out = {};
    for (const [key, inner] of disabled) {
      const models = {};
      for (const [id, row] of inner) {
        if (row && row.until > Date.now()) models[id] = row;
      }
      if (Object.keys(models).length) out[key] = models;
    }
    fs.writeFileSync(persistPath, `${JSON.stringify({ disabled: out }, null, 2)}\n`, { mode: 0o600 });
  }

  readPersist();

  function isDisabledKey(key, modelId) {
    const inner = disabled.get(key);
    if (!inner) return false;
    const row = inner.get(modelId);
    if (!row) return false;
    if (row.until && row.until <= Date.now()) {
      inner.delete(modelId);
      if (!inner.size) disabled.delete(key);
      writePersist();
      return false;
    }
    return true;
  }

  async function load(account) {
    const key = accountKey(account);
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return hit;
    const fetcher = account.kind === "api" ? fetchOfficial : fetchSand;
    try {
      const raw = await fetcher(account);
      const ids = new Set(namesOf(raw));
      const rec = { ids, expiresAt: now + ttlMs, error: null, kind: account.kind };
      cache.set(key, rec);
      return rec;
    } catch (e) {
      log(`model allowlist ${account.name}: ${e.message}`);
      const rec = {
        ids: hit && hit.ids ? hit.ids : null,
        expiresAt: now + errorTtlMs,
        error: e.message,
        kind: account.kind,
      };
      cache.set(key, rec);
      return rec;
    }
  }

  function disable(account, requested, official, reason, opts = {}) {
    const key = accountKey(account);
    const id = canonicalId(requested, official || (account && account.kind === "api"));
    if (!key || !id) return;
    const until = parseQuotaReset(reason);
    if (!disabled.has(key)) disabled.set(key, new Map());
    const inner = disabled.get(key);
    const row = { until, reason: String(reason || "").slice(0, 300) };
    const targets = [id];
    if (opts.family) {
      const rec = cache.get(key);
      const fam = familyId(id);
      if (rec && rec.ids && fam) {
        for (const mid of rec.ids) {
          if (familyId(mid) === fam && !targets.includes(mid)) targets.push(mid);
        }
      }
    }
    for (const mid of targets) inner.set(mid, row);
    writePersist();
    log(`disabled ${targets.join(",")} on ${account.name || key.slice(0, 12)} until ${new Date(until).toISOString()}`);
  }

  async function verifyLimits(accounts) {
    if (typeof verifyOfficial !== "function") return;
    for (const account of accounts || []) {
      if (account.kind !== "api") continue;
      const key = accountKey(account);
      const rec = cache.get(key);
      if (!rec || !rec.ids) continue;
      for (const mid of verifyModels) {
        if (!rec.ids.has(mid) || isDisabledKey(key, mid)) continue;
        const stamp = `${key}:${mid}`;
        if (verified.has(stamp)) continue;
        verified.add(stamp);
        try {
          const result = await verifyOfficial(account, mid);
          const status = result && typeof result === "object" ? result.status : result;
          const detail = result && typeof result === "object" ? result.detail : result;
          if (status === "quota") disable(account, mid, true, detail || "verify: usage limit");
        } catch (e) {
          log(`verify ${mid} on ${account.name}: ${e.message}`);
        }
      }
    }
  }

  async function refresh(accounts) {
    await Promise.all((accounts || []).map(load));
    await verifyLimits(accounts);
  }

  function covers(account, requested, official) {
    const key = accountKey(account);
    const canon = canonicalId(requested, official);
    if (isDisabledKey(key, canon)) return false;
    const rec = cache.get(key);
    if (!rec || !rec.ids) return true;
    return modelCovered(rec.ids, requested, official);
  }

  function union(kind) {
    const ids = new Set();
    for (const [key, rec] of cache) {
      if (!rec || !rec.ids) continue;
      if (kind && rec.kind !== kind) continue;
      for (const id of rec.ids) {
        if (isDisabledKey(key, id)) continue;
        ids.add(id);
      }
    }
    return ids;
  }

  function status() {
    const accounts = [];
    for (const [key, rec] of cache) {
      const blocked = [];
      const inner = disabled.get(key);
      if (inner) {
        for (const [id, row] of inner) {
          if (row.until > Date.now()) blocked.push(id);
        }
      }
      accounts.push({
        key: key.slice(0, 20),
        kind: rec.kind,
        models: rec.ids ? rec.ids.size : 0,
        disabled: blocked,
        error: rec.error || undefined,
      });
    }
    return { accounts, sand: union("sand").size, api: union("api").size };
  }

  return { refresh, covers, union, status, load, disable, namesOf };
}

module.exports = { createAccountModels, modelCovered, namesOf, stripOfficial, canonicalId, parseQuotaReset };
