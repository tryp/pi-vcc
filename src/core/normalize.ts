import type { Message } from "@earendil-works/pi-ai";
import type { NormalizedBlock } from "../types";
import { textOf } from "./content";
import { sanitize } from "./sanitize";

/**
 * The message shapes `normalize` accepts.
 *
 * pi-ai's `Message` covers user/assistant/toolResult. A pi session also holds
 * `custom` messages (everything an extension injected via `sendMessage`),
 * `bashExecution` (`!` commands), and `branchSummary`/`compactionSummary`.
 *
 * Callers holding only provider messages keep passing `Message[]` unchanged.
 * Callers holding raw session messages (the compaction hook) pass those
 * directly instead of flattening through `convertToLlm` first, which is what
 * erased the customType and made every extension message look like a human
 * turn.
 */
export type NormalizableMessage =
  | Message
  | { role: "custom"; customType?: string; content?: unknown; details?: unknown }
  | { role: "bashExecution"; command?: string; output?: string; exitCode?: number | undefined; excludeFromContext?: boolean }
  | { role: "branchSummary" | "compactionSummary"; summary?: string };

// Byte-exact re-implementation of pi-core's createBranchSummaryMessage /
// createCompactionSummaryMessage wrappers, which are not exported from
// @earendil-works/pi-coding-agent. Note the asymmetry in pi-core: the branch
// suffix has no leading newline, the compaction suffix does.
const BRANCH_SUMMARY_TEXT = (summary: string) =>
  `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${summary}</summary>`;
const COMPACTION_SUMMARY_TEXT = (summary: string) =>
  `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;

const contentText = (content: unknown): string =>
  typeof content === "string" ? content : textOf(content as Message["content"]);

const normalizeOne = (msg: NormalizableMessage, msgIndex: number): NormalizedBlock[] => {
  const role = (msg as { role: string }).role;

  if (role === "user") {
    const m = msg as Message;
    const blocks: NormalizedBlock[] = [];
    const text = sanitize(textOf(m.content));
    if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });
    if (m.content && typeof m.content !== "string") {
      for (const part of m.content) {
        if (part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex: msgIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }

  if (role === "bashExecution") {
    const m = msg as { command?: string; output?: string; exitCode?: number | undefined; excludeFromContext?: boolean };
    // `!!` commands are excluded from provider context; convertToLlm dropped
    // them outright, so skipping here preserves that guarantee instead of
    // leaking them into the summary now that we no longer flatten.
    if (m.excludeFromContext) return [];
    return [{ kind: "bash", command: m.command ?? "", output: m.output ?? "", exitCode: m.exitCode, sourceIndex: msgIndex }];
  }

  if (role === "toolResult") {
    const m = msg as Message & { isError?: boolean; toolName?: string };
    const isError = m.isError === true;
    return [{
      kind: "tool_result",
      name: (m as { toolName?: string }).toolName ?? "",
      text: sanitize(textOf(m.content)),
      ...(isError ? { isError: true } : {}),
      sourceIndex: msgIndex,
    }];
  }

  if (role === "custom") {
    // Extension-injected. Keep the provenance: these are subagent intercom
    // asks, job completions, LSP auto-diags, and similar — never human turns.
    const m = msg as { customType?: string; content?: unknown; details?: unknown };
    const customType = m.customType ?? "unknown";
    // A custom content array can carry image parts, which convertToLlm passed
    // through to the provider. contentText() keeps only text parts, so note the
    // images explicitly rather than dropping them.
    const images = Array.isArray(m.content)
      ? m.content
          .filter((part): part is { type: "image"; mimeType?: string } =>
            !!part && typeof part === "object" && (part as { type?: unknown }).type === "image")
          .map((part) => `[image: ${part.mimeType ?? "unknown"}]`)
      : [];
    const text = [contentText(m.content), ...images].filter(Boolean).join("\n");
    return [{
      kind: "custom",
      customType,
      text: sanitize(text),
      ...(m.details !== undefined ? { details: m.details } : {}),
      sourceIndex: msgIndex,
    }];
  }

  if (role === "branchSummary" || role === "compactionSummary") {
    const summary = (msg as { summary?: string }).summary ?? "";
    if (!summary) return [];
    return [{
      kind: "custom",
      customType: role === "branchSummary" ? "pi-branch-summary" : "pi-compaction-summary",
      text: sanitize(role === "branchSummary" ? BRANCH_SUMMARY_TEXT(summary) : COMPACTION_SUMMARY_TEXT(summary)),
      sourceIndex: msgIndex,
    }];
  }

  if (role === "assistant") {
    const m = msg as Message;
    if (!m.content) return [];
    if (typeof m.content === "string") {
      return [{ kind: "assistant", text: sanitize(m.content), sourceIndex: msgIndex }];
    }

    const blocks: NormalizedBlock[] = [];
    for (const part of m.content) {
      if (part.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text), sourceIndex: msgIndex });
      } else if (part.type === "toolCall") {
        blocks.push({
          kind: "tool_call",
          name: part.name,
          args: part.arguments,
          sourceIndex: msgIndex,
        });
      }
    }
    return blocks;
  }

  return [];
};

export const normalize = (messages: readonly NormalizableMessage[]): NormalizedBlock[] =>
  messages.flatMap((msg, i) => normalizeOne(msg, i));