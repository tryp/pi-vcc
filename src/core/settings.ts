import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const SETTINGS_PATH_DEFAULT = join(homedir(), ".pi", "agent", "pi-vcc-config.json");
const settingsPath = (): string => process.env.PI_VCC_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();

export interface PiVccSettings {
  /**
   * When true (default), pi-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - auto threshold / overflow
   *   - /pi-vcc (always handled regardless)
   *
   * When false, pi-vcc only handles /pi-vcc; everything else falls back to
   * pi core's default LLM-based compaction. Existing config files keep their
   * stored value; the new default applies to fresh installs only.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), pi-vcc boosts the default keep-tail when the current
   * keep:1 tail is small enough. Specifically: if the estimated tail for keep:1
   * is <= smartKeepTailLegacyMinTokens, increase keep up to the largest N whose
   * tail stays <= legacyTailTokens. Explicit `keep:N` from the user is always
   * respected and never adjusted.
   */
  smartKeepTail: boolean;
  /** Tail target as a fraction of the host budget; 25_000 / 170_000 preserves today's effective tail. */
  tailBudgetFraction: number;
  /** Minimum tail target as a fraction of the host budget, before the oversize safety clamp. */
  tailBudgetMinFraction: number;
  /** Summary floor target as a fraction of the host budget; downgraded only when needed for small budgets. */
  summaryFloorFraction: number;
  /** Summary ceiling target as a fraction of the host budget, also bounded by summaryCeilingMaxTokens. */
  summaryCeilingFraction: number;
  /** Reference budget used to derive legacy summary sizes when host limits are absent. */
  summaryReferenceBudgetTokens: number;
  /** Absolute quality cap for summary output, independent of context-window size. */
  summaryCeilingMaxTokens: number;
  /** Optional absolute retained-tail override; when set, it takes precedence over the fraction. */
  tailBudgetTokens: number | null;
  /** Oversize tolerance ratio used by the retained-tail safety guard. */
  oversizedTailFactor: number;
  /** Smart-keep threshold as a fraction of the resolved tail budget. */
  smartKeepTailMinFraction: number;
  /** Smart-keep minimum-token fallback when host limits are absent. */
  smartKeepTailLegacyMinTokens: number;
  /** Legacy absolute retained-tail fallback used only when host limits are absent. */
  legacyTailTokens: number;
  /**
   * When true (default), pi-vcc asks the agent to continue after a successful
   * automatic compaction (threshold, or overflow after the assistant already
   * finished with stop). This avoids a UX cliff where the agent finishes a response,
   * immediately compacts, and then stops instead of continuing the task.
   * Overflow retry is still owned by pi-core via willRetry.
   */
  continueAfterThresholdCompact: boolean;
  /** When true (default), continue after manual compaction when the turn ended in error. */
  continueAfterManualCompactionOnError: boolean;
  /** Write debug snapshot to /tmp/pi-vcc-debug.json on each compaction. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: PiVccSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  tailBudgetFraction: 25_000 / 170_000,
  tailBudgetMinFraction: 4_000 / 170_000,
  summaryFloorFraction: 1_100 / 170_000,
  summaryCeilingFraction: 2_000 / 170_000,
  summaryReferenceBudgetTokens: 170_000,
  summaryCeilingMaxTokens: 4_000,
  tailBudgetTokens: null,
  oversizedTailFactor: 2.5,
  smartKeepTailMinFraction: 0.2,
  smartKeepTailLegacyMinTokens: 5_000,
  legacyTailTokens: 25_000,
  continueAfterThresholdCompact: true,
  continueAfterManualCompactionOnError: true,
  debug: false,
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

export function loadSettings(): PiVccSettings {
  const parsed = readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  const settings = { ...DEFAULT_SETTINGS, ...(parsed as Partial<PiVccSettings>) };
  const readFraction = (key: keyof PiVccSettings): number => {
    const value = parsed[key as string];
    if (value === undefined) return DEFAULT_SETTINGS[key] as number;
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) return value;
    console.warn(`[pi-vcc] Invalid ${key}=${JSON.stringify(value)}; using default ${DEFAULT_SETTINGS[key]}`);
    return DEFAULT_SETTINGS[key] as number;
  };
  const readPositiveTokens = (key: "summaryReferenceBudgetTokens" | "summaryCeilingMaxTokens" | "legacyTailTokens" | "smartKeepTailLegacyMinTokens" | "oversizedTailFactor"): number => {
    const value = parsed[key];
    if (value === undefined) return DEFAULT_SETTINGS[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    console.warn(`[pi-vcc] Invalid ${key}=${JSON.stringify(value)}; using default ${DEFAULT_SETTINGS[key]}`);
    return DEFAULT_SETTINGS[key];
  };
  settings.tailBudgetFraction = readFraction("tailBudgetFraction");
  settings.tailBudgetMinFraction = readFraction("tailBudgetMinFraction");
  settings.smartKeepTailMinFraction = readFraction("smartKeepTailMinFraction");
  settings.summaryFloorFraction = readFraction("summaryFloorFraction");
  settings.summaryCeilingFraction = readFraction("summaryCeilingFraction");
  settings.summaryReferenceBudgetTokens = readPositiveTokens("summaryReferenceBudgetTokens");
  settings.summaryCeilingMaxTokens = readPositiveTokens("summaryCeilingMaxTokens");
  settings.legacyTailTokens = readPositiveTokens("legacyTailTokens");
  settings.oversizedTailFactor = readPositiveTokens("oversizedTailFactor");
  settings.smartKeepTailLegacyMinTokens = readPositiveTokens("smartKeepTailLegacyMinTokens");
  const absoluteTailTokens = parsed.tailBudgetTokens;
  if (absoluteTailTokens === undefined || absoluteTailTokens === null) {
    settings.tailBudgetTokens = null;
  } else if (typeof absoluteTailTokens === "number" && Number.isFinite(absoluteTailTokens) && absoluteTailTokens > 0) {
    settings.tailBudgetTokens = absoluteTailTokens;
  } else {
    console.warn(`[pi-vcc] Invalid tailBudgetTokens=${JSON.stringify(absoluteTailTokens)}; ignoring absolute override`);
    settings.tailBudgetTokens = null;
  }
  return settings;
}

/**
 * Ensure ~/.pi/agent/pi-vcc-config.json exists with default keys.
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export function scaffoldSettings(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      return;
    }

    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort; never crash extension load
  }
}
