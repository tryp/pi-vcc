import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Path to the pi settings file that contains compaction.maxContextTokens. */
const PI_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/**
 * Read maxContextTokens from the pi settings.json.
 * Returns null when the setting is missing or unparseable.
 */
function readMaxContextTokens(): number | null {
  try {
    const content = readFileSync(PI_SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const compaction = parsed?.compaction as Record<string, unknown> | undefined;
    const value = compaction?.maxContextTokens;
    return typeof value === "number" && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Format a token count for display.
 *   - >= 1000 → "X.XK" (e.g. "167.3K")
 *   - < 1000  → "XXX"  (e.g. "842")
 */
const fmtTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
};

export const registerTurnEndHook = (pi: ExtensionAPI) => {
  // ── Show context gauge on every turn end ──
  pi.on("turn_end", (event, ctx) => {
    if (!ctx?.ui) return;

    const { message } = event;
    if (message.role !== "assistant") return;

    const usage = (message as Record<string, unknown>).usage as
      | Record<string, unknown>
      | undefined;
    const totalTokens =
      typeof usage?.totalTokens === "number"
        ? usage.totalTokens
        : typeof usage?.total === "number"
          ? usage.total
          : null;
    if (totalTokens == null || totalTokens <= 0) return;

    const maxTokens = readMaxContextTokens();
    if (maxTokens == null) return;

    const percent = Math.round((totalTokens / maxTokens) * 100);
    const label = `ctx ${fmtTokens(totalTokens)}/${fmtTokens(maxTokens)} (${percent}%)`;
    ctx.ui.setStatus("pi-vcc-context", label);
  });

  // ── Clear the context gauge after compaction ──
  // The gauge will be re-set by the next turn_end with the post-compaction usage.
  pi.on("session_compact", (event, ctx) => {
    if (!ctx?.ui) return;
    ctx.ui.setStatus("pi-vcc-context", undefined);
  });
};
