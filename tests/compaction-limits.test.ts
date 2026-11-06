import { describe, expect, test } from "bun:test";
import { readHostCompactionLimits, resolveSummaryBudgets, resolveTailBudget } from "../src/core/compaction-limits";
import { MAX_SMART_TAIL_TOKENS, OVERSIZED_TAIL_FACTOR } from "../src/hooks/before-compact";

describe("dynamic compaction limits", () => {
  test("uses host limits only when the complete resolved contract is present", () => {
    const event = {
      effectiveContextWindow: 272000,
      effectiveBudget: 239360,
      firstCostTierBoundary: null,
      triggerTokens: 203456,
      triggerFraction: 0.85,
      reserveTokens: 16000,
      windowSource: "backend",
    };
    expect(readHostCompactionLimits(event)).toEqual({ limits: event, fromHost: true });
    expect(readHostCompactionLimits({ ...event, triggerTokens: undefined })).toEqual({ limits: null, fromHost: false });
    expect(readHostCompactionLimits({ ...event, effectiveBudget: 0 })).toEqual({ limits: null, fromHost: false });
  });

  test("keeps legacy absolute tail cap when an old host omits limits", () => {
    expect(resolveTailBudget(null, 0.15, MAX_SMART_TAIL_TOKENS, OVERSIZED_TAIL_FACTOR, 2000)).toBe(25000);
    expect(resolveSummaryBudgets(null)).toEqual({ floorTokens: 1100, ceilingTokens: 2000 });
  });

  test("fractional limit preserves the current cap on ordinary and large windows", () => {
    for (const budget of [170000, 239360, 1000000]) {
      expect(resolveTailBudget(budget, 0.15, 25000, 2.5, 2000)).toBe(25000);
    }
  });

  test("tier-clamped host budget wins over the larger context window", () => {
    const limits = readHostCompactionLimits({
      effectiveContextWindow: 500000,
      effectiveBudget: 272000,
      firstCostTierBoundary: 272000,
      triggerTokens: 239360,
      triggerFraction: 0.88,
      reserveTokens: 16000,
      windowSource: "backend",
    });
    expect(limits.fromHost).toBe(true);
    expect(limits.limits?.effectiveBudget).toBe(272000);
    expect(resolveTailBudget(limits.limits?.effectiveBudget ?? null, 0.15, 25000, 2.5, 2000)).toBe(25000);
  });

  test("small windows proportionally reduce tail and summary budgets below the host budget", () => {
    const budget = 32000;
    const summary = resolveSummaryBudgets(budget);
    const tail = resolveTailBudget(budget, 0.15, 25000, 2.5, summary.ceilingTokens);
    expect(tail).toBe(4800);
    expect(tail * OVERSIZED_TAIL_FACTOR + summary.ceilingTokens).toBeLessThanOrEqual(budget);
    expect(summary).toEqual({ floorTokens: 1100, ceilingTokens: 2000 });

    const tinyBudget = 3000;
    const tinySummary = resolveSummaryBudgets(tinyBudget);
    const tinyTail = resolveTailBudget(tinyBudget, 0.15, 25000, 2.5, tinySummary.ceilingTokens);
    expect(tinyTail * OVERSIZED_TAIL_FACTOR + tinySummary.ceilingTokens).toBeLessThanOrEqual(tinyBudget);
    expect(resolveSummaryBudgets(1000)).toEqual({ floorTokens: 50, ceilingTokens: 100 });
  });

  test("invalid fractions fall back safely and zero/negative budgets do not produce negative tails", () => {
    expect(resolveTailBudget(32000, Number.NaN, 25000, 2.5, 2000)).toBe(4800);
    expect(resolveTailBudget(32000, 2, 25000, 2.5, 2000)).toBe(4800);
    expect(resolveTailBudget(-1, 0.15, 25000, 2.5, 2000)).toBe(25000);
  });
});
