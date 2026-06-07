import type { FileOps, NormalizedBlock, FileActivity, PerFileDetail } from "../types";
import { extractPath } from "../core/tool-args";

const FILE_READ_TOOLS = new Set([
  "Read", "read_file", "View",
]);

const FILE_WRITE_TOOLS = new Set([
  "Edit", "Write", "edit", "write", "edit_file", "write_file",
  "MultiEdit",
]);

const FILE_CREATE_TOOLS = new Set([
  "Write", "write", "write_file",
]);

/** Tools that count as edits (writes that modify existing files) */
const FILE_EDIT_TOOLS = new Set([
  "Edit", "edit", "edit_file", "MultiEdit",
]);

/** Patterns in bash output or tool_error that indicate a problem with a file */
const FILE_STATUS_NEGATIVE_RE = /\b(fail|error|exit code [1-9]|not found|syntax|unexpected|cannot)\b/i;

/**
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 */
const longestCommonDirPrefix = (paths: string[]): string => {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return ""; // require at least /a/b common
  return split[0].slice(0, i).join("/") + "/";
};

const trimPaths = (set: Set<string>, prefix: string): Set<string> => {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
};

export const extractFiles = (
  blocks: NormalizedBlock[],
  fileOps?: FileOps,
): FileActivity => {
  const details = new Map<string, PerFileDetail>();
  const read = new Set(fileOps?.readFiles ?? []);
  const modified = new Set(fileOps?.modifiedFiles ?? []);
  const created = new Set(fileOps?.createdFiles ?? []);

  // First pass: collect all file operations from tool_calls
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;

    if (FILE_READ_TOOLS.has(b.name)) read.add(p);
    if (FILE_WRITE_TOOLS.has(b.name)) modified.add(p);
    if (FILE_CREATE_TOOLS.has(b.name)) created.add(p);

    const op = { tool: b.name, timestamp: i };
    const existing = details.get(p);
    if (existing) {
      existing.ops.push(op);
    } else {
      details.set(p, {
        path: p,
        ops: [op],
        status: FILE_CREATE_TOOLS.has(b.name) ? "needs fixtures" : undefined,
      });
    }
  }

  // Second pass: detect error status after file writes
  const lastWriteIndex = new Map<string, number>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind === "tool_call") {
      const p = extractPath(b.args);
      if (p && (FILE_WRITE_TOOLS.has(b.name) || FILE_CREATE_TOOLS.has(b.name))) {
        lastWriteIndex.set(p, i);
      }
    }
    // Check bash blocks with non-zero exit codes for file references
    if (b.kind === "bash" && b.exitCode != null && b.exitCode !== 0) {
      const cmdOutput = ((b.command || "") + " " + (b.output || "")).toLowerCase();
      for (const [filePath, writeIdx] of lastWriteIndex) {
        if (writeIdx >= i) continue; // only check blocks after the write
        const basename = filePath.split("/").pop()?.toLowerCase() || "";
        if (cmdOutput.includes(basename) || cmdOutput.includes(filePath.toLowerCase())) {
          const detail = details.get(filePath);
          if (detail && !detail.status) {
            detail.status = "needs fix";
          }
        }
      }
    }
    // Check tool_result blocks with errors
    if (b.kind === "tool_result" && b.isError) {
      const errText = (b.text || "").toLowerCase();
      for (const [filePath, writeIdx] of lastWriteIndex) {
        if (writeIdx >= i) continue;
        const basename = filePath.split("/").pop()?.toLowerCase() || "";
        if (errText.includes(basename) || errText.includes(filePath.toLowerCase())) {
          const detail = details.get(filePath);
          if (detail && !detail.status) {
            detail.status = "needs fix";
          }
        }
      }
    }
  }

  // Mark modified files without detected errors as "done"
  for (const p of modified) {
    const detail = details.get(p);
    if (detail && detail.ops.some((o) => FILE_EDIT_TOOLS.has(o.tool)) && !detail.status) {
      detail.status = "done";
    }
  }

  // Dedup: if already Modified, drop from Created (file existed before)
  for (const p of modified) created.delete(p);

  // Apply common-dir prefix trimming to sets and detail keys
  const all = [...read, ...modified, ...created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    const trimSet = (s: Set<string>) => {
      const out = new Set<string>();
      for (const p of s) out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
      return out;
    };
    const trimmedDetails = new Map<string, PerFileDetail>();
    for (const [p, d] of details) {
      const tp = p.startsWith(prefix) ? p.slice(prefix.length) : p;
      trimmedDetails.set(tp, { ...d, path: tp });
    }
    return {
      read: trimSet(read),
      modified: trimSet(modified),
      created: trimSet(created),
      details: trimmedDetails,
    };
  }

  return { read, modified, created, details };
};
