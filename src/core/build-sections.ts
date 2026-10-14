import type { FileOps, NormalizedBlock, PerFileDetail } from "../types";
import { clip, clipSentence, nonEmptyLines, firstLine } from "./content";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractFiles } from "../extract/files";
import { extractPreferences, dedupPreferencesAgainstGoals } from "../extract/preferences";
import { extractCommits, formatCommits } from "../extract/commits";
import { buildBriefSections, stringifyBrief } from "./brief";
import { describeCustom, labelToken } from "./provenance";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  briefBlocks?: NormalizedBlock[];
  /** Hook-provided file activity; authoritative for files touched before this compaction. */
  fileOps?: FileOps;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const extractOutstandingContext = (blocks: NormalizedBlock[]): string[] => {
  const items: string[] = [];
  const tail = blocks.slice(-30);

  for (const b of tail) {
    if (b.kind === "tool_result" && b.isError) {
      const first = firstLine(b.text, 150);
      const clipped = `[${b.name}] ${first}`;
      if (!items.includes(clipped)) items.push(clipped);
      continue;
    }

    if (b.kind === "bash" && b.exitCode != null && b.exitCode !== 0) {
      const first = firstLine(b.output || "(no output)", 150);
      const clipped = `[bash exit ${b.exitCode}] ${first}`;
      if (!items.includes(clipped)) items.push(clipped);
      continue;
    }

    if (b.kind === "assistant" || b.kind === "user" || b.kind === "custom") {
      for (const line of nonEmptyLines(b.text)) {
        if (!BLOCKER_RE.test(line)) continue;
        if (line.length < 15) continue;
        // Skip continuation fragments (sub-bullets, parentheticals, dangling clauses)
        if (/^\s*[-*+>]\s/.test(line)) continue;
        if (/^\s*\(/.test(line)) continue;
        // Require sentence-like start: capital letter, code identifier, or quote
        if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;
        // Attribute to whoever actually spoke: a subagent reporting a blocker
        // is outstanding context, but it is not the user's blocker.
        const speaker = b.kind === "user"
          ? "[user]"
          : b.kind === "custom" ? labelToken(describeCustom(b.customType, b.details, b.text)) : "";
        const clipped = speaker ? `${speaker} ${clipSentence(line, 150)}` : clipSentence(line, 150);
        if (!items.includes(clipped)) items.push(clipped);
        break;
      }
    }
  }

  return items.slice(0, 8);
};

const FILE_WRITE_COUNT_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "edit_file", "write_file",
  "MultiEdit",
]);

const countWriteOps = (detail: PerFileDetail): number =>
  detail.ops.filter((o) => FILE_WRITE_COUNT_TOOLS.has(o.tool)).length;

const describeModified = (detail: PerFileDetail): string => {
  const edits = countWriteOps(detail);
  if (edits > 0) return `Edited (${edits} edit${edits !== 1 ? "s" : ""})`;
  return "Written";
};

const formatFileActivity = (blocks: NormalizedBlock[], fileOps?: FileOps): string[] => {
  const act = extractFiles(blocks, fileOps);

  // If no per-file details were collected (e.g., fileOps-only input), fall back to flat format
  if (act.details.size === 0) {
    const lines: string[] = [];
    const cap = (set: Set<string>, limit: number) => {
      const arr = [...set];
      if (arr.length <= limit) return arr.join(", ");
      return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
    };
    if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
    if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
    if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
    return lines;
  }
  const lines: string[] = [];
  const MAX_ENTRIES = 15;
  let count = 0;

  // Modified files with details (status)
  for (const p of act.modified) {
    if (count >= MAX_ENTRIES) break;
    const detail = act.details.get(p);
    if (!detail) continue;
    const desc = describeModified(detail);
    const statusStr = detail.status ? `. Status: ${detail.status}` : "";
    lines.push(`Modified: ${p} — ${desc}${statusStr}`);
    count++;
  }

  // Created files
  for (const p of act.created) {
    if (count >= MAX_ENTRIES) break;
    const detail = act.details.get(p);
    const statusStr = detail?.status ? `. Status: ${detail.status}` : ". Status: needs fixtures";
    lines.push(`Created: ${p} — New file${statusStr}`);
    count++;
  }

  // Read files (no status)
  for (const p of act.read) {
    if (count >= MAX_ENTRIES) break;
    if (act.modified.has(p)) continue; // skip if already shown as modified
    lines.push(`Read: ${p} — Read`);
    count++;
  }

  return lines;
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks } = input;
  const briefSections = buildBriefSections(input.briefBlocks ?? blocks);
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    sessionGoal,
  );
  return {
    sessionGoal,
    outstandingContext: extractOutstandingContext(blocks),
    filesAndChanges: formatFileActivity(blocks, input.fileOps),
    commits: formatCommits(extractCommits(blocks)),
    userPreferences,
    briefTranscript: stringifyBrief(briefSections),
  };
};
