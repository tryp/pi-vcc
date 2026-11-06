import { DEFAULT_SETTINGS } from "./settings";

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
  capApplied: boolean | null;
  capValue: number | null;
  capSource: "absolute" | "fraction" | null;
  capMetadataInvalid: boolean;
}

export interface ResolvedHostLimits {
  limits: HostCompactionLimits | null;
  fromHost: boolean;
  reason: "absent" | "invalid" | null;
  failedKey: string | null;
  capApplied: boolean | null;
  capValue: number | null;
  capSource: "absolute" | "fraction" | null;
  capMetadataInvalid: boolean;
}

const finitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;
const finiteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const validFraction = (value: unknown): value is number => finitePositive(value) && value <= 1;

/**
 * Read only the host's resolved decision. Incomplete/old-host events deliberately
 * return null: callers must retain legacy behavior rather than guess a window.
 */
export function readHostCompactionLimits(event: unknown): ResolvedHostLimits {
  const empty = (reason: "absent" | "invalid", failedKey: string | null, cap = parseCapMetadata(null)) => ({
    limits: null,
    fromHost: false,
    reason,
    failedKey,
    ...cap,
  });
  if (!event || typeof event !== "object") return empty("absent", null);
  const value = event as Record<string, unknown>;
  const cap = parseCapMetadata(value);
  const requiredKeys = [
    "effectiveContextWindow", "effectiveBudget", "firstCostTierBoundary", "triggerTokens",
    "triggerFraction", "reserveTokens", "windowSource",
  ];
  const optionalKeys = ["tailBudgetTokens"];
  if (![...requiredKeys, ...optionalKeys].some((key) => key in value)) return empty("absent", null, cap);
  const invalidKey = requiredKeys.find((key) => {
    switch (key) {
      case "effectiveContextWindow": return !finitePositive(value[key]);
      case "effectiveBudget": return !finitePositive(value[key]);
      case "firstCostTierBoundary": return !(value[key] === null || finitePositive(value[key]));
      case "triggerTokens": return !finiteNonNegative(value[key]);
      case "triggerFraction": return !validFraction(value[key]);
      case "reserveTokens": return !finiteNonNegative(value[key]);
      case "windowSource": return !["backend", "static", "stored", "default"].includes(String(value[key]));
      default: return true;
    }
  });
  if (invalidKey) return empty("invalid", invalidKey, cap);
  if (!(value.tailBudgetTokens === undefined || value.tailBudgetTokens === null || finitePositive(value.tailBudgetTokens))) {
    return empty("invalid", "tailBudgetTokens", cap);
  }
  return {
    fromHost: true,
    reason: null,
    failedKey: null,
    ...cap,
    limits: {
      effectiveContextWindow: value.effectiveContextWindow as number,
      effectiveBudget: value.effectiveBudget as number,
      firstCostTierBoundary: value.firstCostTierBoundary as number | null,
      triggerTokens: value.triggerTokens as number,
      triggerFraction: value.triggerFraction as number,
      reserveTokens: value.reserveTokens as number,
      tailBudgetTokens: finitePositive(value.tailBudgetTokens) ? value.tailBudgetTokens : null,
      windowSource: value.windowSource as HostCompactionLimits["windowSource"],
      capApplied: cap.capApplied,
      capValue: cap.capValue,
      capSource: cap.capSource,
      capMetadataInvalid: cap.capMetadataInvalid,
    },
  };
}

function parseCapMetadata(value: Record<string, unknown> | null): Pick<ResolvedHostLimits, "capApplied" | "capValue" | "capSource" | "capMetadataInvalid"> {
  if (!value) return { capApplied: null, capValue: null, capSource: null, capMetadataInvalid: false };
  const appliedPresent = "capApplied" in value;
  const valuePresent = "capValue" in value;
  const sourcePresent = "capSource" in value;
  const capApplied = typeof value.capApplied === "boolean" ? value.capApplied : null;
  const capValue = finiteNonNegative(value.capValue) ? value.capValue : null;
  const capSource = value.capSource === "absolute" || value.capSource === "fraction" ? value.capSource : null;
  const capMetadataInvalid =
    (appliedPresent && typeof value.capApplied !== "boolean") ||
    (valuePresent && value.capValue !== null && !finiteNonNegative(value.capValue)) ||
    (sourcePresent && value.capSource !== null && value.capSource !== "absolute" && value.capSource !== "fraction");
  return { capApplied, capValue, capSource, capMetadataInvalid };
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
  reserveTokens: number | null,
  hostAbsoluteTokens: number | null,
  settingsAbsoluteTokens: number | null,
  fraction: number,
  minFraction: number,
  legacyTailTokens: number,
  oversizedFactor: number,
  summaryBudgetCeiling: number,
): TailBudgetDecision {
  const hasBudget = effectiveBudget !== null && finitePositive(effectiveBudget);
  const safeFraction = validFraction(fraction) ? fraction : DEFAULT_SETTINGS.tailBudgetFraction;
  const safeMinFraction = validFraction(minFraction) ? minFraction : DEFAULT_SETTINGS.tailBudgetMinFraction;
  const safeLegacyTailTokens = finitePositive(legacyTailTokens) ? legacyTailTokens : DEFAULT_SETTINGS.legacyTailTokens;
  const safeOversizedFactor = finitePositive(oversizedFactor) ? oversizedFactor : DEFAULT_SETTINGS.oversizedTailFactor;
  const safeSummaryCeiling = finiteNonNegative(summaryBudgetCeiling) ? summaryBudgetCeiling : DEFAULT_SETTINGS.summaryCeilingMaxTokens;
  let target: number;
  let source: TailBudgetDecision["source"];
  if (finitePositive(hostAbsoluteTokens)) {
    target = hostAbsoluteTokens;
    source = "host_absolute";
  } else if (finitePositive(settingsAbsoluteTokens)) {
    target = settingsAbsoluteTokens;
    source = "settings_absolute";
  } else if (hasBudget) {
    target = Math.max(Math.floor(effectiveBudget * safeMinFraction), Math.floor(effectiveBudget * safeFraction));
    source = "fraction";
  } else {
    target = safeLegacyTailTokens;
    source = "legacy_fallback";
  }
  if (!hasBudget) return { tokens: target, source, safetyClamped: false };
  if (finiteNonNegative(reserveTokens) && effectiveBudget <= reserveTokens) {
    return { tokens: 0, source, safetyClamped: true };
  }
  const maxTailPlusSummary = Math.max(0, effectiveBudget - Math.min(safeSummaryCeiling, effectiveBudget));
  const maxTokensBeforeOversize = Math.floor(maxTailPlusSummary / safeOversizedFactor);
  return {
    tokens: Math.min(target, maxTokensBeforeOversize),
    source,
    safetyClamped: target > maxTokensBeforeOversize,
  };
}

export function resolveTailBudget(
  effectiveBudget: number | null,
  reserveTokens: number | null,
  fraction: number,
  minFraction: number,
  legacyTailTokens: number,
  oversizedFactor: number,
  summaryBudgetCeiling: number,
): number {
  return resolveTailBudgetDecision(
    effectiveBudget,
    reserveTokens,
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
  const budget = effectiveBudget !== null && finitePositive(effectiveBudget)
    ? effectiveBudget
    : finitePositive(referenceBudgetTokens) ? referenceBudgetTokens : DEFAULT_SETTINGS.summaryReferenceBudgetTokens;
  const safeFloorFraction = validFraction(floorFraction) ? floorFraction : DEFAULT_SETTINGS.summaryFloorFraction;
  const safeCeilingFraction = validFraction(ceilingFraction) ? ceilingFraction : DEFAULT_SETTINGS.summaryCeilingFraction;
  const safeCeilingMaxTokens = finitePositive(ceilingMaxTokens) ? ceilingMaxTokens : DEFAULT_SETTINGS.summaryCeilingMaxTokens;
  const ceilingTokens = Math.min(safeCeilingMaxTokens, Math.floor(budget * safeCeilingFraction));
  const floorTokens = Math.min(ceilingTokens, Math.floor(budget * safeFloorFraction));
  return { floorTokens, ceilingTokens };
}
