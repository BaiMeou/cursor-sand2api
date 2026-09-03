// Cursor SuperGrok is a weekly Grok Bot bucket. "Grok Bot Plan" is the
// membership that actually lets named Claude/Kimi ride that sand pool.
// SuperGrok / SuperGrok Heavy still 403 named models with spend-limit copy.

function grokPlanLabel(usage) {
  if (!usage || typeof usage !== "object") return "";
  return String(usage.grokPlanLabel || usage.includedUsageSuperGrokPlan || usage.plan || "");
}

function isGrokBotPlan(usageOrToken) {
  if (!usageOrToken || typeof usageOrToken !== "object") return false;
  const label = usageOrToken.grokPlanLabel
    ? String(usageOrToken.grokPlanLabel)
    : grokPlanLabel(usageOrToken);
  if (/super\s*grok/i.test(label)) return false;
  return /grok\s*bot/i.test(label);
}

function applyUsage(token, usage) {
  if (!token || !usage || typeof usage !== "object") return token;
  token.grokPlanLabel = grokPlanLabel(usage);
  token.sandUsagePercent = usage.usagePercent;
  token.hasAvailableUsage = usage.hasAvailableUsage;
  return token;
}

module.exports = { grokPlanLabel, isGrokBotPlan, applyUsage };
