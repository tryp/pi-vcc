import type { Message } from "@earendil-works/pi-ai";

/**
 * Why a compaction ran.
 *
 * - `manual`: a user asked for it (`/compact`, `/pi-vcc`).
 * - `threshold`: pi's own pre-send/after-turn threshold compaction.
 * - `overflow`: pi's recovery after a context-overflow rejection.
 * - `extension`: an extension asked for it through `ctx.compact()`, which pi core
 *   reports distinctly from `manual`. Treat it as a caller-requested compaction:
 *   it is a deliberate request, not one of the two automatic recovery paths, so
 *   the source-message floor and the overflow fallback must not apply to it.
 */
export type CompactionReason = "manual" | "threshold" | "overflow" | "extension";

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export interface PerFileDetail {
  path: string;
  ops: Array<{ tool: string; timestamp: number }>;
  status?: string;
}

export interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
  details: Map<string, PerFileDetail>;
}

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; isError?: boolean; sourceIndex?: number }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number }
  /**
   * An extension-injected message: a subagent notification, an intercom ask, a
   * background-job completion, an LSP auto-diag, or anything else an extension
   * delivered via sendMessage(). These are NOT human turns — they carry their
   * own provenance so the summary can name the source instead of mislabeling
   * them `[user]`.
   */
  | { kind: "custom"; customType: string; text: string; details?: unknown; sourceIndex?: number };
