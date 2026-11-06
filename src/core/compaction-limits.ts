/** Optional context limits supplied by pi core on session_before_compact. */
export interface HostCompactionLimits {
  effectiveContextWindow: number;
  effectiveBudget: number;
  firstCostTierBoundary: number | null;
  triggerTokens: number;
  triggerFraction: number;
  reserveTokens: number;
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
      windowSource: value.windowSource as HostCompactionLimits["windowSource"],
    },
  };
}

/**
 * Resolve VCC's retained-tail target. The legacy absolute value remains a hard
 * ceiling; a fraction can only reduce it. Budget absent means exact old behavior.
 */
export function resolveTailBudget(
  effectiveBudget: number | null,
  fraction: number,
  legacyMaxTokens: number,
  oversizedFactor: number,
  summaryBudgetCeiling: number,
): number {
  if (effectiveBudget === null || !finitePositive(effectiveBudget)) return legacyMaxTokens;
  const safeFraction = Number.isFinite(fraction) && fraction > 0 && fraction <= 1 ? fraction : 0.15;
  const maxTailPlusSummary = Math.max(0, effectiveBudget - Math.min(summaryBudgetCeiling, effectiveBudget));
  const maxTokensBeforeOversize = Math.floor(maxTailPlusSummary / Math.max(1, oversizedFactor));
  return Math.max(0, Math.min(legacyMaxTokens, Math.floor(effectiveBudget * safeFraction), maxTokensBeforeOversize));
}

export function resolveSummaryBudgets(effectiveBudget: number | null): { floorTokens: number; ceilingTokens: number } {
  if (effectiveBudget === null || !finitePositive(effectiveBudget)) {
    return { floorTokens: 1100, ceilingTokens: 2000 };
  }
  return {
    floorTokens: Math.max(0, Math.min(1100, Math.floor(effectiveBudget * 0.05))),
    ceilingTokens: Math.max(0, Math.min(2000, Math.floor(effectiveBudget * 0.1))),
  };
}
