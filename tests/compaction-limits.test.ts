import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DEFAULT_SETTINGS, loadSettings } from "../src/core/settings";
import {
  readHostCompactionLimits,
  resolveSummaryBudgets,
  resolveTailBudget,
  resolveTailBudgetDecision,
} from "../src/core/compaction-limits";
import { MAX_SMART_TAIL_TOKENS, OVERSIZED_TAIL_FACTOR } from "../src/hooks/before-compact";

const settingsDirs: string[] = [];
const originalSettingsPath = process.env.PI_VCC_CONFIG_PATH;
afterEach(() => {
  process.env.PI_VCC_CONFIG_PATH = originalSettingsPath;
  for (const dir of settingsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("dynamic compaction limits", () => {
  test("uses host limits only when the complete resolved contract is present", () => {
    const event = {
      effectiveContextWindow: 272000,
      effectiveBudget: 239360,
      firstCostTierBoundary: null,
      triggerTokens: 203456,
      triggerFraction: 0.85,
      reserveTokens: 16000,
      tailBudgetTokens: null,
      windowSource: "backend" as const,
    };
    expect(readHostCompactionLimits(event)).toEqual({ limits: event, fromHost: true });
    expect(readHostCompactionLimits({ ...event, triggerTokens: undefined })).toEqual({ limits: null, fromHost: false });
    expect(readHostCompactionLimits({ ...event, effectiveBudget: 0 })).toEqual({ limits: null, fromHost: false });
  });

  test("default settings reproduce the deployed 170k behavior", () => {
    const summary = resolveSummaryBudgets(
      170000,
      DEFAULT_SETTINGS.summaryFloorFraction,
      DEFAULT_SETTINGS.summaryCeilingFraction,
      DEFAULT_SETTINGS.summaryCeilingMaxTokens,
      DEFAULT_SETTINGS.summaryReferenceBudgetTokens,
    );
    const tail = resolveTailBudget(
      170000,
      DEFAULT_SETTINGS.tailBudgetFraction,
      DEFAULT_SETTINGS.tailBudgetMinFraction,
      DEFAULT_SETTINGS.legacyTailTokens,
      OVERSIZED_TAIL_FACTOR,
      summary.ceilingTokens,
    );
    expect(tail).toBe(25000);
    expect(summary).toEqual({ floorTokens: 1100, ceilingTokens: 2000 });
    expect(MAX_SMART_TAIL_TOKENS).toBe(DEFAULT_SETTINGS.legacyTailTokens);
  });

  test("configured fraction is primary and monotonic across host budgets", () => {
    const { tailBudgetFraction: fraction, tailBudgetMinFraction: minimum } = DEFAULT_SETTINGS;
    const budgets = [32000, 170000, 239360, 272000, 500000];
    const tails = budgets.map((budget) =>
      resolveTailBudget(budget, fraction, minimum, DEFAULT_SETTINGS.legacyTailTokens, OVERSIZED_TAIL_FACTOR, 2000),
    );

    for (let index = 0; index < budgets.length; index++) {
      const beforeOversizeGuard = Math.floor((budgets[index] - 2000) / OVERSIZED_TAIL_FACTOR);
      const fractionTarget = Math.floor(budgets[index] * fraction);
      const minimumTarget = Math.floor(budgets[index] * minimum);
      expect(tails[index]).toBe(Math.min(Math.max(fractionTarget, minimumTarget), beforeOversizeGuard));
      if (index > 0) expect(tails[index]).toBeGreaterThan(tails[index - 1]);
    }
    expect(tails[1]).toBe(25000);
    expect(resolveTailBudget(170000, 0.25, minimum, DEFAULT_SETTINGS.legacyTailTokens, OVERSIZED_TAIL_FACTOR, 2000)).toBe(42500);
    expect(tails[2]).toBe(Math.floor(239360 * fraction));
    expect(tails[2] / tails[1]).toBeCloseTo(budgets[2] / budgets[1], 2);
    expect(tails[3]).toBe(272000 * fraction);
  });

  test("a configured absolute tail beats the fraction, subject to the safety clamp", () => {
    const host = resolveTailBudgetDecision(170000, 50000, 30000, 0.147, 0.0235, 25000, 2.5, 2000);
    expect(host).toMatchObject({ tokens: 50000, source: "host_absolute", safetyClamped: false });
    const setting = resolveTailBudgetDecision(170000, null, 30000, 0.147, 0.0235, 25000, 2.5, 2000);
    expect(setting).toMatchObject({ tokens: 30000, source: "settings_absolute", safetyClamped: false });
    const clamped = resolveTailBudgetDecision(16000, null, 12000, 0.147, 0.0235, 25000, 2.5, 1600);
    expect(clamped).toMatchObject({ tokens: 5760, source: "settings_absolute", safetyClamped: true });
  });

  test("summary fractions scale with budget and the absolute cap bounds large windows", () => {
    const { summaryFloorFraction, summaryCeilingFraction, summaryCeilingMaxTokens, summaryReferenceBudgetTokens } = DEFAULT_SETTINGS;
    const summaryAt170k = resolveSummaryBudgets(170000, summaryFloorFraction, summaryCeilingFraction, summaryCeilingMaxTokens, summaryReferenceBudgetTokens);
    const summaryAt239k = resolveSummaryBudgets(239360, summaryFloorFraction, summaryCeilingFraction, summaryCeilingMaxTokens, summaryReferenceBudgetTokens);
    expect(summaryAt170k).toEqual({ floorTokens: 1100, ceilingTokens: 2000 });
    expect(summaryAt239k.floorTokens).toBe(Math.floor(239360 * summaryFloorFraction));
    expect(summaryAt239k.ceilingTokens).toBe(Math.min(summaryCeilingMaxTokens, Math.floor(239360 * summaryCeilingFraction)));
    expect(resolveSummaryBudgets(1000000, summaryFloorFraction, summaryCeilingFraction, summaryCeilingMaxTokens, summaryReferenceBudgetTokens).ceilingTokens).toBe(summaryCeilingMaxTokens);
  });

  test("legacy tail is an exact fallback when limits are absent", () => {
    const decision = resolveTailBudgetDecision(null, null, null, DEFAULT_SETTINGS.tailBudgetFraction, DEFAULT_SETTINGS.tailBudgetMinFraction, DEFAULT_SETTINGS.legacyTailTokens, OVERSIZED_TAIL_FACTOR, 2000);
    expect(decision).toEqual({ tokens: DEFAULT_SETTINGS.legacyTailTokens, source: "legacy_fallback", safetyClamped: false });
  });

  test("oversize guard governs a small host budget and keeps tail plus summary within budget", () => {
    const budget = 16000;
    const summary = resolveSummaryBudgets(budget, DEFAULT_SETTINGS.summaryFloorFraction, DEFAULT_SETTINGS.summaryCeilingFraction, DEFAULT_SETTINGS.summaryCeilingMaxTokens, DEFAULT_SETTINGS.summaryReferenceBudgetTokens);
    const target = Math.floor(budget * 0.5);
    const guard = Math.floor((budget - summary.ceilingTokens) / OVERSIZED_TAIL_FACTOR);
    const decision = resolveTailBudgetDecision(budget, null, null, 0.5, DEFAULT_SETTINGS.tailBudgetMinFraction, DEFAULT_SETTINGS.legacyTailTokens, OVERSIZED_TAIL_FACTOR, summary.ceilingTokens);
    expect(target).toBeGreaterThan(guard);
    expect(decision.tokens).toBe(guard);
    expect(decision.safetyClamped).toBe(true);
    expect(decision.tokens * OVERSIZED_TAIL_FACTOR + summary.ceilingTokens).toBeLessThanOrEqual(budget);
  });

  test("invalid configured fractions fall back to defaults with a visible warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-limits-"));
    settingsDirs.push(dir);
    process.env.PI_VCC_CONFIG_PATH = join(dir, "settings.json");
    writeFileSync(process.env.PI_VCC_CONFIG_PATH, JSON.stringify({ tailBudgetFraction: 2, summaryFloorFraction: "bad" }));
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const settings = loadSettings();
      expect(settings.tailBudgetFraction).toBe(DEFAULT_SETTINGS.tailBudgetFraction);
      expect(settings.summaryFloorFraction).toBe(DEFAULT_SETTINGS.summaryFloorFraction);
      expect(warning).toHaveBeenCalledTimes(2);
      expect(warning.mock.calls.map(([message]) => message).join("\n")).toContain("Invalid tailBudgetFraction");
      expect(warning.mock.calls.map(([message]) => message).join("\n")).toContain("Invalid summaryFloorFraction");
    } finally {
      warning.mockRestore();
    }
  });
});
