// Public OpenAI ids are family names. Cursor still wants a variant slug on
// InferenceService; this module is the only place that mapping is allowed.

const TIERS = ["low", "medium", "high", "xhigh", "max"];
const ALL_TIERS = ["none", "minimal", ...TIERS];
const TIER_SET = new Set(ALL_TIERS);
const LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const TIER_ALT = ALL_TIERS.join("|");

const DOTTED_TO_FAMILY = {
  "claude-fable": "claude-fable-5-1",
  "claude-fable-5.1": "claude-fable-5-1",
  "claude-sonnet-4.5": "claude-4.5-sonnet",
  "claude-sonnet-4-5": "claude-4.5-sonnet",
  "claude-sonnet-4.6": "claude-4.6-sonnet",
  "claude-sonnet-4-6": "claude-4.6-sonnet",
  "claude-opus-4.5": "claude-4.5-opus",
  "claude-opus-4-5": "claude-4.5-opus",
  "claude-opus-4.6": "claude-4.6-opus",
  "claude-opus-4-6": "claude-4.6-opus",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-opus-4.8": "claude-opus-4-8",
  "claude-haiku-4.5": "claude-haiku-4-5",
  "claude-haiku-4-5": "claude-haiku-4-5",
};

function str(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function stripApi(id) {
  const raw = str(id).trim();
  if (raw.toLowerCase().startsWith("api-")) return { official: true, rest: raw.slice(4) };
  return { official: false, rest: raw };
}

function suffixRe() {
  return new RegExp(`-(thinking-)?(${TIER_ALT})(?:-fast)?$`, "i");
}

function invertedThinkingRe() {
  return new RegExp(`-(?:(${TIER_ALT})-)?thinking(?:-fast)?$`, "i");
}

function parseSlug(id) {
  const { official, rest } = stripApi(id);
  let raw = rest;
  const dotted = DOTTED_TO_FAMILY[raw.toLowerCase()];
  if (dotted) raw = dotted;

  const kimi = raw.match(/^(kimi-k3)-(low|high|max)$/i);
  if (kimi) {
    return {
      family: "kimi-k3",
      thinking: true,
      tier: kimi[2].toLowerCase(),
      official,
      slug: rest,
      fast: false,
    };
  }

  const grok = raw.match(/^(?:cursor-)?grok-4\.6(?:-(low|medium|high|xhigh))?$/i);
  if (grok) {
    return {
      family: "grok-4.6",
      thinking: Boolean(grok[1]),
      tier: grok[1] ? grok[1].toLowerCase() : null,
      official,
      slug: rest,
      fast: false,
    };
  }

  // Cursor Claude also spells variants as `{family}-{tier}-thinking`.
  const inverted = raw.match(invertedThinkingRe());
  if (inverted) {
    return {
      family: raw.slice(0, inverted.index),
      thinking: true,
      tier: inverted[1] ? inverted[1].toLowerCase() : null,
      official,
      slug: rest,
      fast: /fast$/i.test(inverted[0]),
    };
  }

  const m = raw.match(suffixRe());
  if (m) {
    const family = raw.slice(0, m.index);
    const tier = m[2].toLowerCase();
    return {
      family,
      thinking: Boolean(m[1]),
      tier,
      official,
      slug: rest,
      fast: /fast$/i.test(m[0]),
    };
  }

  return { family: raw, thinking: false, tier: null, official, slug: rest, fast: false };
}

function familyId(id) {
  return parseSlug(id).family;
}

function isSuffixPrimary(id) {
  const p = parseSlug(id);
  if (p.tier || p.thinking) return true;
  const rest = stripApi(id).rest;
  if (/^kimi-k3-(low|high|max)$/i.test(rest)) return true;
  if (/^(?:cursor-)?grok-4\.6-(low|medium|high|xhigh)(?:-fast)?$/i.test(rest)) return true;
  if (new RegExp(`-(thinking-)?(${TIER_ALT})(?:-fast)?$`, "i").test(rest)) return true;
  if (new RegExp(`-(?:(${TIER_ALT})-)?thinking(?:-fast)?$`, "i").test(rest)) return true;
  return false;
}

function dottedAliases(family) {
  const out = [];
  for (const [from, to] of Object.entries(DOTTED_TO_FAMILY)) {
    if (to.toLowerCase() === family.toLowerCase()) out.push(from);
  }
  return out;
}

function collapseIds(ids) {
  const seen = new Set();
  const out = [];
  for (const id of ids || []) {
    if (!id || id === "default") continue;
    const fam = familyId(id);
    const key = fam.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fam);
  }
  return out;
}

function membersOf(family, ids) {
  const want = familyId(family).toLowerCase();
  return (ids || []).filter((id) => {
    if (!id) return false;
    const fam = familyId(id).toLowerCase();
    if (fam === want) return true;
    // 0.9.9: a bare `-fast` slug is its own family, but still the fast twin.
    if (fam === `${want}-fast`) return true;
    if (String(id).toLowerCase() === `${want}-fast`) return true;
    return false;
  });
}

function typicalSlugs(family) {
  const fam = familyId(family);
  if (fam === "kimi-k3") return ["kimi-k3-low", "kimi-k3-high", "kimi-k3-max"];
  if (fam === "grok-4.6") {
    const out = [];
    for (const t of ["low", "medium", "high", "xhigh"]) {
      out.push(`cursor-grok-4.6-${t}`, `cursor-grok-4.6-${t}-fast`);
    }
    return out;
  }
  if (/^claude/i.test(fam)) {
    const out = [fam, `${fam}-thinking`, `${fam}-fast`, `${fam}-thinking-fast`];
    for (const t of TIERS) {
      out.push(`${fam}-${t}`);
      out.push(`${fam}-thinking-${t}`);
      out.push(`${fam}-${t}-thinking`);
      out.push(`${fam}-${t}-fast`);
      out.push(`${fam}-thinking-${t}-fast`);
      out.push(`${fam}-${t}-thinking-fast`);
    }
    return out;
  }
  return [fam];
}

function preferFast(slug, slugs) {
  const p = parseSlug(slug);
  if (p.fast || /fast$/i.test(slug)) return slug;
  const list = slugs || [];
  const twin = list.find((s) => {
    const q = parseSlug(s);
    return q.family === p.family && q.thinking === p.thinking && String(q.tier) === String(p.tier) && q.fast;
  });
  if (twin) return twin;
  const want = `${slug}-fast`;
  const suffixed = list.find((s) => s.toLowerCase() === want.toLowerCase());
  return suffixed || slug;
}

function publishedRungs(family, ids, catalog) {
  const slugs = membersOf(family, ids && ids.length ? ids : typicalSlugs(family));
  const rungs = [];
  const add = (v) => {
    const n = str(v).toLowerCase();
    if (!n || rungs.includes(n)) return;
    rungs.push(n);
  };
  for (const slug of slugs) {
    const p = parseSlug(slug);
    if (p.tier) add(p.tier);
  }
  const entry = catalogEntryForFamily(family, catalog);
  const params = entry && entry.params && typeof entry.params === "object" ? entry.params : {};
  for (const key of ["effort", "reasoning"]) {
    for (const v of params[key] || []) add(v);
  }
  const hasNoneTier = slugs.some((s) => parseSlug(s).tier === "none");
  const mixed =
    hasNonThinking(slugs) &&
    slugs.some((s) => {
      const p = parseSlug(s);
      return p.thinking || (p.tier && p.tier !== "none");
    });
  if ((mixed || hasNoneTier) && !rungs.includes("none")) rungs.unshift("none");
  return LADDER.filter((r) => rungs.includes(r)).concat(rungs.filter((r) => !LADDER.includes(r)));
}

function hasNonThinking(slugs) {
  return (slugs || []).some((s) => !parseSlug(s).thinking);
}

function pickNonThinking(slugs) {
  const list = (slugs || []).filter((s) => !parseSlug(s).thinking);
  if (!list.length) return null;
  const bare = list.find((s) => !parseSlug(s).tier);
  if (bare) return bare;
  const prefer = ["high", "max", "medium", "xhigh", "low"];
  for (const t of prefer) {
    const hit = list.find((s) => parseSlug(s).tier === t);
    if (hit) return hit;
  }
  return list[0];
}

function pickNoneSlug(slugs) {
  const list = slugs || [];
  const noneExact = list.find((s) => {
    const p = parseSlug(s);
    return p.tier === "none" && !p.fast;
  });
  if (noneExact) return noneExact;
  const noneAny = list.find((s) => parseSlug(s).tier === "none");
  if (noneAny) return noneAny;
  return pickNonThinking(list);
}

function pickThinking(slugs, tier) {
  const want = str(tier).toLowerCase();
  const thinkingHit = (slugs || []).find((s) => {
    const p = parseSlug(s);
    return p.thinking && p.tier === want;
  });
  if (thinkingHit) return thinkingHit;
  // A family that publishes *-thinking-* must not fall back to the non-thinking
  // *-high sibling — that is how reasoning_effort looked like it "worked" while
  // Cursor never emitted a thinking part.
  const familyHasThinking = (slugs || []).some((s) => parseSlug(s).thinking);
  if (familyHasThinking) return null;
  return (slugs || []).find((s) => {
    const p = parseSlug(s);
    return p.tier === want;
  }) || null;
}

function catalogEntryForFamily(family, catalog) {
  if (!catalog || typeof catalog !== "object") return null;
  const fam = familyId(family);
  if (catalog[fam]) return catalog[fam];
  const low = fam.toLowerCase();
  for (const [id, entry] of Object.entries(catalog)) {
    if (!entry) continue;
    if (id.toLowerCase() === low) return entry;
    if (familyId(id).toLowerCase() === low) return entry;
    const aliases = entry.aliases || [];
    if (aliases.some((a) => familyId(a).toLowerCase() === low || String(a).toLowerCase() === low)) return entry;
    const legacy = entry.legacySlugs || [];
    if (legacy.some((s) => familyId(s).toLowerCase() === low)) return entry;
    const variants = entry.variants || [];
    if (variants.some((v) => v && v.slug && familyId(v.slug).toLowerCase() === low)) return entry;
  }
  return null;
}

function catalogDefaultSlug(family, slugs, catalog) {
  const entry = catalogEntryForFamily(family, catalog);
  if (!entry || !Array.isArray(entry.variants)) return null;
  const def = entry.variants.find((v) => v && v.isDefault && v.slug) || entry.variants.find((v) => v && v.slug);
  if (!def || !def.slug) return null;
  if ((slugs || []).includes(def.slug)) return def.slug;
  return null;
}

function familyFallbackSlug(family, slugs) {
  const list = slugs || [];
  if (family === "kimi-k3") return list.find((s) => /kimi-k3-max$/i.test(s)) || null;
  if (family === "grok-4.6") {
    return (
      list.find((s) => /grok-4\.6-xhigh-fast$/i.test(s)) ||
      list.find((s) => /grok-4\.6-xhigh$/i.test(s)) ||
      list.find((s) => /grok-4\.6-high-fast$/i.test(s)) ||
      list.find((s) => /grok-4\.6-high$/i.test(s)) ||
      null
    );
  }
  return null;
}

function bareFamilySlug(family, slugs) {
  return (slugs || []).find((s) => {
    const p = parseSlug(s);
    return p.family === family && !p.thinking && !p.tier;
  }) || null;
}

function effortField(body) {
  const src = body && typeof body === "object" ? body : {};
  if (src.reasoning_effort != null && String(src.reasoning_effort).trim() !== "") {
    return { param: "reasoning_effort", raw: src.reasoning_effort };
  }
  const reasoning = src.reasoning && typeof src.reasoning === "object" ? src.reasoning : {};
  if (reasoning.effort != null && String(reasoning.effort).trim() !== "") {
    return { param: "reasoning.effort", raw: reasoning.effort };
  }
  const thinking = src.thinking && typeof src.thinking === "object" ? src.thinking : {};
  if (thinking.effort != null && String(thinking.effort).trim() !== "") {
    return { param: "thinking.effort", raw: thinking.effort };
  }
  if (thinking.budget_tokens != null && thinking.budget_tokens !== "") {
    return { param: "thinking.budget_tokens", raw: thinking.budget_tokens };
  }
  if (thinking.budgetTokens != null && thinking.budgetTokens !== "") {
    return { param: "thinking.budget_tokens", raw: thinking.budgetTokens };
  }
  return { param: "reasoning_effort", raw: null };
}

function budgetToRung(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw);
  if (n <= 1024) return "low";
  if (n <= 2048) return "medium";
  return "high";
}

function effortError(param, value, supported) {
  const listed = supported.length ? supported.map((s) => `'${s}'`).join(", ") : "(none)";
  return {
    error: {
      message: `Invalid value: '${value}' for '${param}'. Supported values: ${listed}.`,
      type: "invalid_request_error",
      param,
      code: "invalid_value",
    },
  };
}

function collapseEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const groups = new Map();
  const order = [];
  for (const entry of list) {
    if (!entry || !entry.id) continue;
    const fam = familyId(entry.id);
    const key = fam.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(entry);
  }
  return order.map((key) => {
    const members = groups.get(key);
    const family = familyId(members[0].id);
    const aliases = [];
    const addAlias = (a) => {
      if (!a || a === family || aliases.includes(a)) return;
      aliases.push(a);
    };
    for (const m of members) {
      addAlias(m.id === family ? "" : m.id);
      for (const a of m.aliases || []) addAlias(a);
    }
    for (const a of dottedAliases(family)) addAlias(a);
    const display =
      (members[0].displayName || "")
        .replace(/\s+(Low|Medium|High|XHigh|Max|Fast|Thinking.*)$/i, "")
        .trim() || family;
    const caps = members.reduce((acc, m) => {
      const c = m.capabilities;
      if (!c) return acc;
      if (!acc) return { ...c };
      return {
        images: Boolean(acc.images || c.images),
        thinking: Boolean(acc.thinking || c.thinking),
        maxMode: Boolean(acc.maxMode || c.maxMode),
        agent: Boolean(acc.agent || c.agent),
      };
    }, null);
    return {
      ...members[0],
      id: family,
      displayName: display,
      aliases,
      capabilities: caps || members[0].capabilities,
    };
  });
}

function pickAliasSlug(parsed, slugs) {
  if (!parsed || (!parsed.tier && !parsed.thinking)) return null;
  const family = parsed.family;
  const original = str(parsed.slug);
  const exact = (slugs || []).find((s) => s.toLowerCase() === original.toLowerCase());
  if (exact) return { slug: exact, effort: parsed.tier || parseSlug(exact).tier };
  if (parsed.tier === "none") {
    const slug = pickNoneSlug(slugs);
    return slug ? { slug, effort: "none" } : null;
  }
  if (parsed.tier) {
    const slug = pickThinking(slugs, parsed.tier);
    if (slug) return { slug, effort: parsed.tier };
    if (parsed.thinking) return { slug: `${family}-thinking-${parsed.tier}`, effort: parsed.tier };
    return { slug: `${family}-${parsed.tier}`, effort: parsed.tier };
  }
  const thinking = (slugs || []).find((s) => parseSlug(s).thinking);
  if (thinking) return { slug: thinking, effort: parseSlug(thinking).tier };
  return { slug: `${family}-thinking-high`, effort: "high" };
}

function resolveOpenAIModel(requested, body, options = {}) {
  const { official, rest } = stripApi(requested);
  const parsed = parseSlug(rest);
  const aliasParsed = parseSlug(options.requestedSlug || rest);
  const family = parsed.family;
  const usable = Array.isArray(options.usable) ? options.usable.filter(Boolean) : [];
  let slugs = membersOf(family, usable);
  if (!slugs.length) slugs = typicalSlugs(family);
  const field = effortField(body);
  const rungs = publishedRungs(family, slugs, options.catalog);
  const thinkingRungs = rungs.filter((r) => r !== "none");

  // 0.9.9: omitted effort stays on the catalog/bare slug. Fast is the only
  // default upgrade. Suffix aliases keep the exact slug they asked for.
  const flagged = (slug, effort) => ({
    family,
    slug,
    effort,
    official,
    fast: parseSlug(slug).fast || /fast$/i.test(slug),
  });
  const withFast = (slug, effort) => flagged(preferFast(slug, slugs), effort);
  const exact = (slug, effort) => flagged(slug, effort);

  if (field.raw != null && field.raw !== "") {
    let want = String(field.raw).trim().toLowerCase();
    if (field.param === "thinking.budget_tokens") want = budgetToRung(field.raw);
    if (want === "none") {
      if (!rungs.includes("none")) {
        return { error: effortError(field.param, field.raw, rungs.length ? rungs : thinkingRungs) };
      }
      return withFast(pickNoneSlug(slugs) || family, "none");
    }
    if (!thinkingRungs.includes(want)) {
      return { error: effortError(field.param, field.raw, rungs.length ? rungs : thinkingRungs) };
    }
    return withFast(pickThinking(slugs, want) || `${family}-thinking-${want}`, want);
  }

  // Old suffix aliases (kimi-k3-max, *-thinking-max, *-medium-thinking) still
  // select a rung when the caller did not send reasoning_effort.
  const alias = pickAliasSlug(aliasParsed, slugs);
  if (alias) return exact(alias.slug, alias.effort);

  const catalogSlug = catalogDefaultSlug(family, slugs, options.catalog);
  if (catalogSlug) return withFast(catalogSlug, null);
  const bare = bareFamilySlug(family, slugs);
  if (bare) return withFast(bare, null);
  const fallback = familyFallbackSlug(family, slugs);
  if (fallback) return withFast(fallback, null);
  const non = pickNonThinking(slugs);
  if (non) return withFast(non, null);
  return withFast(slugs[0] || family, null);
}

function resolvePublicRequest(requestedModel, body, options = {}) {
  const { official, rest } = stripApi(requestedModel);
  const mapped = typeof options.mapModel === "function" ? options.mapModel(rest) : rest;
  const resolved = resolveOpenAIModel(mapped, body, { ...options, requestedSlug: rest });
  if (resolved.error) return { error: resolved.error, official };
  if (official) {
    return { modelId: resolved.family || mapped, effort: resolved.effort, official: true, family: resolved.family };
  }
  return { modelId: resolved.slug, effort: resolved.effort, official: false, family: resolved.family };
}

function familyCovers(ids, requested) {
  if (!ids || typeof ids.has !== "function") return true;
  if (!ids.size) return false;
  if (ids.has(requested)) return true;
  const { rest } = stripApi(requested);
  if (ids.has(rest)) return true;
  const fam = familyId(requested).toLowerCase();
  const stem = fam.replace(/-fast$/i, "");
  for (const id of ids) {
    const idFam = familyId(id).toLowerCase();
    if (idFam === fam) return true;
    if (idFam === `${fam}-fast` || String(id).toLowerCase() === `${fam}-fast`) return true;
    if (fam === `${stem}-fast` && (idFam === stem || String(id).toLowerCase() === stem)) return true;
  }
  const aliased = DOTTED_TO_FAMILY[rest.toLowerCase()];
  if (aliased && ids.has(aliased)) return true;
  if (aliased) {
    for (const id of ids) {
      const idFam = familyId(id).toLowerCase();
      if (idFam === aliased.toLowerCase() || idFam === `${aliased.toLowerCase()}-fast`) return true;
    }
  }
  return false;
}

// Sand Inference 429s/502s Claude as soon as the proto `tools` field is present.
// Those families keep OpenAI tools by prompting + parsing Anthropic XML.
function sandTextToolsOnly(modelId) {
  return /^claude/i.test(familyId(modelId));
}

module.exports = {
  TIERS,
  DOTTED_TO_FAMILY,
  parseSlug,
  familyId,
  sandTextToolsOnly,
  isSuffixPrimary,
  collapseIds,
  collapseEntries,
  membersOf,
  typicalSlugs,
  publishedRungs,
  effortField,
  effortError,
  resolveOpenAIModel,
  resolvePublicRequest,
  familyCovers,
  dottedAliases,
  catalogEntryForFamily,
};
