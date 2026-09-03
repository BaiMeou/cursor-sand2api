const fs = require("fs");

const DEFAULT_COOLDOWN_MS = 0;

function jwtExpiryMs(jwt) {
  const part = String(jwt || "").split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

function looksOfficial(raw) {
  const key = String((raw && (raw.apiKey || raw.key)) || "");
  if (key.startsWith("crsr_")) return true;
  const kind = String((raw && raw.kind) || "").toLowerCase();
  return kind === "api" || kind === "official" || kind === "crsr";
}

function accountKey(acc) {
  if (!acc) return "";
  if (acc.kind === "api") return `api:${acc.apiKey}`;
  return `sand:${acc.accessToken}`;
}

function normalize(raw, index) {
  const official = looksOfficial(raw);
  const apiKey = official ? String(raw.apiKey || raw.key || "").trim() : "";
  const accessToken = official ? "" : String((raw && raw.accessToken) || "").trim();
  return {
    name: raw.name || raw.label || (official ? `api-${index + 1}` : `account-${index + 1}`),
    kind: official ? "api" : "sand",
    apiKey,
    accessToken,
    machineId: official ? "" : raw.machineId || "",
    macMachineId: official ? "" : raw.macMachineId || "",
    expiresAt: official ? null : jwtExpiryMs(accessToken),
    cooldownUntil: 0,
    failures: 0,
    lastError: "",
  };
}

class TokenPool {
  constructor(file, { cooldownMs = DEFAULT_COOLDOWN_MS, log = () => {} } = {}) {
    this.file = file;
    this.cooldownMs = cooldownMs;
    this.log = log;
    this.accounts = [];
    this.cursor = 0;
    this.mtimeMs = 0;
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") {
        throw new Error(
          `TOKEN_FILE not found (${this.file}) — copy token.json.example and run npm run token`
        );
      }
      throw e;
    }
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data.tokens || data.accounts || [];
    const next = list
      .map((t, i) => (t ? normalize(t, i) : null))
      .filter((t) => {
        if (!t) return false;
        if (t.kind === "api") return t.apiKey && t.apiKey.startsWith("crsr_");
        return t.accessToken && t.accessToken !== "your-cursor-access-token-here";
      });
    if (next.length === 0) throw new Error(`no usable sand JWT or crsr_ apiKey in ${this.file}`);

    // Keep cooldown state across reloads so editing the file does not clear a
    // penalty that is still deserved.
    const prev = new Map(this.accounts.map((a) => [accountKey(a), a]));
    for (const acc of next) {
      const old = prev.get(accountKey(acc));
      if (old) {
        acc.cooldownUntil = old.cooldownUntil;
        acc.failures = old.failures;
        acc.lastError = old.lastError;
      }
    }
    this.accounts = next;
    this.cursor = 0;
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {}
    return this.accounts.length;
  }

  reloadIfChanged() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (st.mtimeMs === this.mtimeMs) return false;
    try {
      const n = this.load();
      this.log(`token file reloaded: ${n} account(s)`);
      return true;
    } catch (e) {
      this.log(`token file reload failed, keeping previous set: ${e.message}`);
      this.mtimeMs = st.mtimeMs;
      return false;
    }
  }

  watch(intervalMs = 5000) {
    try {
      fs.watchFile(this.file, { interval: intervalMs }, () => this.reloadIfChanged());
    } catch {}
  }

  healthy(now = Date.now()) {
    return this.accounts.filter((a) => a.cooldownUntil <= now && !(a.expiresAt && a.expiresAt <= now));
  }

  // Round-robin over healthy accounts. When every account is cooling down we
  // still hand an unexpired one back: a stale cooldown must not turn into a
  // hard outage. Expired JWTs are never used as that fallback.
  // Pass kind "sand" or "api" to stay inside one pool.
  next(kind, filter) {
    if (this.accounts.length === 0) return null;
    const now = Date.now();
    const matches = (a) => (!kind || a.kind === kind) && (!filter || filter(a));
    const healthy = this.healthy(now).filter(matches);
    const unexpired = this.accounts.filter((a) => matches(a) && !(a.expiresAt && a.expiresAt <= now));
    const list = healthy.length ? healthy : unexpired;
    if (!list.length) return null;
    const account = list[this.cursor % list.length];
    this.cursor = (this.cursor + 1) % list.length;
    return account;
  }

  hasReady(kind, filter, now = Date.now()) {
    return this.accounts.some((a) => {
      if (kind && a.kind !== kind) return false;
      if (filter && !filter(a)) return false;
      if (a.expiresAt && a.expiresAt <= now) return false;
      return a.cooldownUntil <= now;
    });
  }

  markKindFailure(kind, error, cooldownMs = this.cooldownMs) {
    if (!kind) return;
    for (const account of this.accounts) {
      if (account.kind === kind) this.markFailure(account, error, cooldownMs);
    }
  }

  markFailure(account, error, cooldownMs = this.cooldownMs) {
    if (!account) return;
    const id = accountKey(account);
    const target = this.accounts.find((a) => accountKey(a) === id);
    if (!target) return;
    target.failures += 1;
    target.lastError = String(error || "").slice(0, 200);
    target.cooldownUntil = cooldownMs > 0 ? Date.now() + cooldownMs : 0;
    if (cooldownMs > 0) {
      this.log(`account ${target.name} cooling down ${Math.round(cooldownMs / 1000)}s: ${target.lastError}`);
    } else {
      this.log(`account ${target.name} fail: ${target.lastError}`);
    }
  }

  markSuccess(account) {
    if (!account) return;
    const id = accountKey(account);
    const target = this.accounts.find((a) => accountKey(a) === id);
    if (!target) return;
    target.failures = 0;
    target.lastError = "";
    target.cooldownUntil = 0;
  }

  publicStatus() {
    const now = Date.now();
    return { total: this.accounts.length, healthy: this.healthy(now).length };
  }

  status() {
    const now = Date.now();
    return {
      total: this.accounts.length,
      healthy: this.healthy(now).length,
      accounts: this.accounts.map((a) => ({
        name: a.name,
        kind: a.kind,
        failures: a.failures,
        cooling: a.cooldownUntil > now ? Math.round((a.cooldownUntil - now) / 1000) : 0,
        expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
        expired: Boolean(a.expiresAt && a.expiresAt <= now),
        lastError: a.lastError || undefined,
      })),
    };
  }
}

module.exports = { TokenPool, jwtExpiryMs, accountKey, looksOfficial };
