import type { Message } from "@earendil-works/pi-ai";
import type { FileOps } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { formatSummary, capBrief, BRIEF_MAX_LINES, RECALL_NOTE, wrapLongLines } from "./format";
import { selectRankedBriefBlocks, type BriefRankingOptions } from "./rank";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
}

export interface RankedCompileInput extends CompileInput {
  ranking?: BriefRankingOptions;
}

const HEADER_NAMES = ["Session Goal", "Files And Changes", "Commits", "Outstanding Context", "User Preferences"];

const SEPARATOR = "\n\n---\n\n";

/** Extract a named section from summary text */
const sectionOf = (text: string, header: string): string => {
  const tag = `[${header}]`;
  const start = text.indexOf(tag);
  if (start < 0) return "";
  const after = text.slice(start);
  // Find next section header or separator
  const nextSection = HEADER_NAMES
    .filter((h) => h !== header)
    .map((h) => after.indexOf(`[${h}]`))
    .filter((n) => n > 0);
  const nextSep = after.indexOf("\n\n---\n\n");
  const candidates = [...nextSection, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
  const end = candidates[0];
  return (end ? after.slice(0, end) : after).trim();
};

/** Extract the brief transcript part (everything after ---) */
const briefOf = (text: string): string => {
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return "";
  return text.slice(idx + SEPARATOR.length).trim();
};

/** Merge a header section */
const mergeHeaderSection = (header: string, prev: string, fresh: string): string => {
  // Outstanding Context is volatile -- always use fresh only
  if (header === "Outstanding Context") return fresh;
  if (!prev) return fresh;
  if (!fresh) return prev;

  // Files And Changes: merge by category (Modified/Created/Read), dedup paths
  if (header === "Files And Changes") {
    return mergeFileLines(prev, fresh);
  }

  // Session Goal, User Preferences: line-level dedup, cap
  const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combined = [...new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  const capped = combined.length > CAP ? combined.slice(-CAP) : combined;
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};

/**
 * Parse file paths from a single "[Files And Changes]" line.
 * Handles both formats:
 *   Old flat: "- Modified: file1, file2 (+N more)"
 *   New per-file: "- Modified: path — description. Status: status"
 * Returns array of { category, path, status?, description? }.
 */
interface FileEntry {
  category: "Modified" | "Created" | "Read";
  path: string;
  status?: string;
  description?: string;
}

const parseFileEntries = (line: string): FileEntry[] => {
  const categories = ["Modified", "Created", "Read"] as const;
  for (const cat of categories) {
    const prefix = `- ${cat}: `;
    if (!line.startsWith(prefix)) continue;
    const rest = line.slice(prefix.length);

    // New per-file format: "path — description[. Status: status]"
    const newFormatMatch = rest.match(/^(.+?) — (.+)$/);
    if (newFormatMatch) {
      const path = newFormatMatch[1].trim();
      const descPart = newFormatMatch[2];
      const statusMatch = descPart.match(/^(.+?)\. Status: (.+)$/);
      return [{
        category: cat,
        path,
        description: statusMatch ? statusMatch[1].trim() : descPart.trim(),
        status: statusMatch ? statusMatch[2].trim() : undefined,
      }];
    }

    // Old flat format: "file1, file2 (+N more)"
    const flatClean = rest.replace(/\s*\(\+\d+ more\)\s*$/, "").trim();
    if (!flatClean) continue;
    return flatClean.split(",").map((p) => p.trim()).filter(Boolean).map((path) => ({
      category: cat,
      path,
    }));
  }
  return [];
};

/** Merge Files And Changes by path, keeping most recent information */
const mergeFileLines = (prev: string, fresh: string): string => {
  // Collect entries: fresh takes priority, then prev
  const entries = new Map<string, FileEntry>();

  const collect = (text: string, isFresh: boolean) => {
    for (const line of text.split("\n")) {
      for (const entry of parseFileEntries(line)) {
        if (!entry.path) continue;
        // Fresh entries override; prev entries fill gaps
        if (!entries.has(entry.path) || isFresh) {
          entries.set(entry.path, entry);
        }
      }
    }
  };

  collect(prev, false);
  collect(fresh, true);

  // Dedup: if a path is both Modified and Created, keep Modified
  const modifiedPaths = new Set<string>();
  for (const [path, entry] of entries) {
    if (entry.category === "Modified") modifiedPaths.add(path);
  }
  for (const path of modifiedPaths) {
    const entry = entries.get(path);
    if (entry && entry.category === "Created") entries.delete(path);
  }

  // Build output in per-file format, grouped by category
  const modifiedLines: string[] = [];
  const createdLines: string[] = [];
  const readLines: string[] = [];

  for (const [path, entry] of entries) {
    // Skip Created if Modified exists (handled above, but double-check)
    if (entry.category === "Created" && modifiedPaths.has(path)) continue;

    const desc = entry.description
      ? ` — ${entry.description}${entry.status ? `. Status: ${entry.status}` : ""}`
      : "";
    const line = `- ${entry.category}: ${path}${desc}`;
    if (entry.category === "Modified") modifiedLines.push(line);
    else if (entry.category === "Created") createdLines.push(line);
    else readLines.push(line);
  }

  const allLines = [...modifiedLines, ...createdLines, ...readLines];
  if (allLines.length === 0) return "";
  return `[Files And Changes]\n${allLines.join("\n")}`;
};

const mergeBriefTranscript = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return prev + "\n\n" + fresh;
};

const briefLineCount = (text: string): number =>
  text ? text.split("\n").length : 0;

const capBriefToLineBudget = (text: string, maxLines: number): string => {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

const mergeBriefTranscriptWithFreshBudget = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return capBrief(prev);
  const freshLines = briefLineCount(fresh);
  const remainingPrevLines = Math.max(0, BRIEF_MAX_LINES - freshLines);
  const prevTail = capBriefToLineBudget(prev, remainingPrevLines);
  return prevTail ? `${prevTail}\n\n${fresh}` : fresh;
};

const mergePrevious = (prev: string, fresh: string, options: { preserveFreshBrief?: boolean } = {}): string => {
  // Merge header sections
  const headers = HEADER_NAMES
    .map((header) => {
      const freshSec = sectionOf(fresh, header);
      const prevSec = sectionOf(prev, header);
      return mergeHeaderSection(header, prevSec, freshSec);
    })
    .filter(Boolean);

  // Merge brief transcript
  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(fresh);
  const mergedBrief = options.preserveFreshBrief
    ? mergeBriefTranscriptWithFreshBudget(prevBrief, freshBrief)
    : mergeBriefTranscript(prevBrief, freshBrief);

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(options.preserveFreshBrief ? mergedBrief : capBrief(mergedBrief));
  }

  return parts.join(SEPARATOR);
};

interface CompileWithBriefBlocksOptions {
  briefBlocksFor?: (blocks: ReturnType<typeof normalize>) => ReturnType<typeof normalize>;
  capFreshBrief?: boolean;
  preserveFreshBriefOnMerge?: boolean;
}

const compileWithBriefBlocks = (input: CompileInput, options: CompileWithBriefBlocksOptions = {}): string => {
  const blocks = filterNoise(normalize(input.messages));
  const briefBlocks = options.briefBlocksFor?.(blocks);
  const data = buildSections({ blocks, briefBlocks, fileOps: input.fileOps });
  const fresh = formatSummary(data, { capBriefTranscript: options.capFreshBrief ?? true });
  // Strip any legacy RECALL_NOTE baked into prev summary (pre-fix format)
  // so merge doesn't re-stack it inside the brief.
  const prev = input.previousSummary
    ? stripRecallNote(input.previousSummary)
    : undefined;
  const merged = prev ? mergePrevious(prev, fresh, { preserveFreshBrief: options.preserveFreshBriefOnMerge }) : fresh;
  if (!merged) return "";
  return wrapLongLines(merged + SEPARATOR + RECALL_NOTE);
};

export const compile = (input: CompileInput): string =>
  compileWithBriefBlocks(input);

export const compileRanked = (input: RankedCompileInput): string =>
  compileWithBriefBlocks(input, {
    briefBlocksFor: (blocks) => selectRankedBriefBlocks(blocks, {
      ...input.ranking,
      fileOps: input.ranking?.fileOps ?? input.fileOps,
    }),
    capFreshBrief: false,
    preserveFreshBriefOnMerge: true,
  });

const stripRecallNote = (text: string): string => {
  // Remove trailing RECALL_NOTE (and any separators surrounding it) if present.
  // Handles both current format (---\n\nNOTE) and bare trailing NOTE.
  const idx = text.lastIndexOf(RECALL_NOTE);
  if (idx < 0) return text;
  return text.slice(0, idx).replace(/\s*(?:\n\n---\n\n)?\s*$/, "").trimEnd();
};
