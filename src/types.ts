import type { Message } from "@earendil-works/pi-ai";

export type CompactionReason = "manual" | "threshold" | "overflow";

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
