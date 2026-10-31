import type { CompactionReason } from "./types";

export interface PiVccCompactionDetails {
  compactor: "pi-vcc";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  reason?: CompactionReason;
  willRetry?: boolean;
  /** Estimated tokens retained after the cut, for offline compaction analysis. */
  keptTokensEst: number;
  /** Cut path selected by the tail-budget logic. */
  budgetCut?: "no_anchor" | "no_anchor_inflight" | "no_anchor_textonly" | "oversized_tail" | "explicit_keep";
}
