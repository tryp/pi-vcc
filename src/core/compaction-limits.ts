/** Optional context limits supplied by pi core on session_before_compact. */
export interface HostCompactionLimits {
  effectiveContextWindow: number;
  effectiveBudget: number;
  firstCostTierBoundary: number | null;
  triggerTokens: number;
  triggerFraction: number;
  reserveTokens: number;
  tailBudgetTokens: number | null;
  windowSource: "backend" | "static" | "stored" | "default";
}

export interface ResolvedHostLimits {
  limits: HostCompactionLimits | null;
  fromHost: boolean;
}

const finitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

/**
 * Read only the host's resolved decision. Incomplete/old-host events deliberately
 * return null: callers must retain legacy behavior rather than guess a window.
 */
export function readHostCompactionLimits(event: unknown): ResolvedHostLimits {
  if (!event || typeof event !== "object") return { limits: null, fromHost: false };
  const value = event as Record<string, unknown>;
  if (
    !finitePositive(value.effectiveContextWindow) ||
    !finitePositive(value.effectiveBudget) ||
    typeof value.triggerTokens !== "number" ||
    !Number.isFinite(value.triggerTokens) ||
    value.triggerTokens < 0 ||
    typeof value.triggerFraction !== "number" ||
    !Number.isFinite(value.triggerFraction) ||
    typeof value.reserveTokens !== "number" ||
    !Number.isFinite(value.reserveTokens) ||
    value.reserveTokens < 0 ||
    !(value.tailBudgetTokens === undefined || value.tailBudgetTokens === null || finitePositive(value.tailBudgetTokens)) ||
    !(value.firstCostTierBoundary === null || finitePositive(value.firstCostTierBoundary)) ||
    !["backend", "static", "stored", "default"].includes(String(value.windowSource))
  ) {
    return { limits: null, fromHost: false };
  }
  return {
    fromHost: true,
    limits: {
      effectiveContextWindow: value.effectiveContextWindow,
      effectiveBudget: value.effectiveBudget,
      firstCostTierBoundary: value.firstCostTierBoundary,
      triggerTokens: value.triggerTokens,
      triggerFraction: value.triggerFraction,
      reserveTokens: value.reserveTokens,
      tailBudgetTokens: finitePositive(value.tailBudgetTokens) ? value.tailBudgetTokens : null,
      windowSource: value.windowSource as HostCompactionLimits["windowSource"],
    },
  };
}

/**
 * Resolve VCC's retained-tail target. With host limits, the configured fraction
 * is primary and the minimum fraction is only a lower target. The legacy token
 * value is used only without host limits. The oversize guard is the final safety
 * clamp, bounding the retained tail and summary against the host budget.
 */
export interface TailBudgetDecision {
  tokens: number;
  source: "host_absolute" | "settings_absolute" | "fraction" | "legacy_fallback";
  safetyClamped: boolean;
}

export function resolveTailBudgetDecision(
  effectiveBudget: number | null,
  hostAbsoluteTokens: number | null,
  settingsAbsoluteTokens: number | null,
  fraction: number,
  minFraction: number,
  legacyTailTokens: number,
  oversizedFactor: number,
  summaryBudgetCeiling: number,
): TailBudgetDecision {
  const hasBudget = effectiveBudget !== null && finitePositive(effectiveBudget);
  let target: number;
  let source: TailBudgetDecision["source"];
  if (finitePositive(hostAbsoluteTokens)) {
    target = hostAbsoluteTokens;
    source = "host_absolute";
  } else if (finitePositive(settingsAbsoluteTokens)) {
    target = settingsAbsoluteTokens;
    source = "settings_absolute";
  } else if (hasBudget) {
    target = Math.max(Math.floor(effectiveBudget * minFraction), Math.floor(effectiveBudget * fraction));
    source = "fraction";
  } else {
    target = legacyTailTokens;
    source = "legacy_fallback";
  }
  if (!hasBudget) return { tokens: target, source, safetyClamped: false };
  const maxTailPlusSummary = Math.max(0, effectiveBudget - Math.min(summaryBudgetCeiling, effectiveBudget));
  const maxTokensBeforeOversize = Math.floor(maxTailPlusSummary / Math.max(1, oversizedFactor));
  return {
    tokens: Math.min(target, maxTokensBeforeOversize),
    source,
    safetyClamped: target > maxTokensBeforeOversize,
  };
}

export function resolveTailBudget(
  effectiveBudget: number | null,
  fraction: number,
  minFraction: number,
  legacyTailTokens: number,
  oversizedFactor: number,
  summaryBudgetCeiling: number,
): number {
  return resolveTailBudgetDecision(
    effectiveBudget,
    null,
    null,
    fraction,
    minFraction,
    legacyTailTokens,
    oversizedFactor,
    summaryBudgetCeiling,
  ).tokens;
}

/**
 * Derive summary floor/ceiling from their configured fractions. The ceiling is
 * also bounded by an absolute quality cap; small budgets naturally downgrade
 * both targets, while a larger context window does not extend output past the cap.
 */
export function resolveSummaryBudgets(
  effectiveBudget: number | null,
  floorFraction: number,
  ceilingFraction: number,
  ceilingMaxTokens: number,
  referenceBudgetTokens: number,
): { floorTokens: number; ceilingTokens: number } {
  const budget = effectiveBudget !== null && finitePositive(effectiveBudget) ? effectiveBudget : referenceBudgetTokens;
  const ceilingTokens = Math.min(ceilingMaxTokens, Math.floor(budget * ceilingFraction));
  const floorTokens = Math.min(ceilingTokens, Math.floor(budget * floorFraction));
  return { floorTokens, ceilingTokens };
}
