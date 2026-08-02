import { describe, it, expect } from "bun:test";
import { buildSections } from "../src/core/build-sections";
import type { NormalizedBlock } from "../src/types";

describe("buildSections", () => {
  it("returns all-empty for no blocks", () => {
    const r = buildSections({ blocks: [] });
    expect(r.sessionGoal).toEqual([]);
    expect(r.outstandingContext).toEqual([]);
    expect(r.briefTranscript).toBe("");
  });

  it("populates sections from realistic blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix the auth bug" },
      { kind: "tool_call", name: "Read", args: { file_path: "auth.ts" } },
      { kind: "tool_result", name: "Read", text: "const x = 1;" },
      { kind: "tool_call", name: "Edit", args: { file_path: "auth.ts" } },
      { kind: "tool_result", name: "Edit", text: "ok" },
      { kind: "assistant", text: "- run tests next" },
    ];
    const r = buildSections({ blocks });
    expect(r.sessionGoal).toContain("Fix the auth bug");
    expect(r.briefTranscript).toContain('[user]');
    expect(r.briefTranscript).toContain('* Read "auth.ts"');
    expect(r.briefTranscript).toContain('* Edit "auth.ts"');
  });

  it("captures outstanding context from user and assistant text", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Tests are still failing after the retry." },
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBeGreaterThan(0);
    expect(r.outstandingContext[0]).toContain("Tests are still failing");
  });

  it("brief transcript hides tool results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "Read", text: "lots of code here ..." },
      { kind: "tool_result", name: "bash", text: "Command not found" },
    ];
    const r = buildSections({ blocks });
    expect(r.briefTranscript).toBe("");
  });

  it("brief transcript merges adjacent assistant sections", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Part one." },
      { kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
      { kind: "assistant", text: "Part two." },
    ];
    const r = buildSections({ blocks });
    const matches = r.briefTranscript.match(/\[assistant\]/g);
    expect(matches?.length).toBe(1);
  });

  it("formatFileActivity emits per-file details with edit count and status", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { file_path: "/home/dev/src/auth.ts" }, sourceIndex: 0 },
      { kind: "tool_call", name: "Edit", args: { file_path: "/home/dev/src/auth.ts" }, sourceIndex: 1 },
      { kind: "tool_call", name: "Edit", args: { file_path: "/home/dev/src/auth.ts" }, sourceIndex: 2 },
      { kind: "tool_call", name: "Read", args: { file_path: "/home/dev/src/utils.ts" }, sourceIndex: 3 },
    ];
    const r = buildSections({ blocks });
    const fac = r.filesAndChanges;
    expect(fac.length).toBeGreaterThan(0);
    // Modified file — should have count and status
    const modifiedLine = fac.find((l) => l.startsWith("Modified: auth.ts"));
    expect(modifiedLine).toBeDefined();
    expect(modifiedLine).toContain("—");
    expect(modifiedLine).toContain("Edited");
    expect(modifiedLine).toContain("2 edits");
    expect(modifiedLine).toContain("Status: done");
    // Read file — no status
    const readLine = fac.find((l) => l.startsWith("Read: utils.ts"));
    expect(readLine).toBeDefined();
    expect(readLine).toContain("—");
  });

  it("formatFileActivity detects error status after failing bash", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" }, sourceIndex: 0 },
      { kind: "tool_call", name: "Read", args: { file_path: "src/utils.ts" }, sourceIndex: 1 },
      { kind: "tool_result", name: "Edit", text: "ok", sourceIndex: 2 },
      { kind: "bash", command: "npm test", output: "Error: auth.ts has syntax error", exitCode: 1, sourceIndex: 3 },
    ];
    const r = buildSections({ blocks });
    const fac = r.filesAndChanges;
    // Use relative paths so no prefix trimming
    const modifiedLine = fac.find((l) => l.startsWith("Modified: src/auth.ts"));
    expect(modifiedLine).toBeDefined();
    expect(modifiedLine).toContain("Status: needs fix");
  });

  it("formatFileActivity falls back to flat format when details are empty", () => {
    // When blocks have no tool_calls with file paths, details will be empty
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "world" },
    ];
    const r = buildSections({ blocks });
    expect(r.filesAndChanges).toEqual([]);
  });
});
