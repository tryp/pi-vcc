import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupCreatedSessionSampleDirectories,
  createSessionSampleDirectory,
  printSessionSampleGcSummary,
  sessionSampleGcSummary,
  sweepSessionSampleDirectories,
} from "./support/real-sessions";

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pi-vcc-gc-test-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await cleanupCreatedSessionSampleDirectories();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pi-vcc session fixture GC", () => {
  it("removes attributable dead-PID directories and reports legacy bytes without deleting legacy dirs", async () => {
    const root = await makeRoot();
    const dead = join(root, `pi-vcc-sessions-99999999-${Date.now()}`);
    const legacy = join(root, "pi-vcc-sessions-20261030-legacy");
    await mkdir(dead);
    await mkdir(legacy);
    await writeFile(join(legacy, "session.jsonl"), "legacy-bytes");

    const counters = sweepSessionSampleDirectories(root, () => false);

    await expect(stat(dead)).rejects.toThrow();
    await expect(readFile(join(legacy, "session.jsonl"), "utf8")).resolves.toBe("legacy-bytes");
    expect(counters).toEqual({
      removed: 1,
      skippedLegacy: 1,
      skippedAlive: 0,
      unreadable: 0,
      legacyBytes: Buffer.byteLength("legacy-bytes"),
    });
  });

  it("keeps attributable directories whose owner PID is alive", async () => {
    const root = await makeRoot();
    const alive = join(root, `pi-vcc-sessions-${process.pid}-${Date.now()}`);
    await mkdir(alive);

    const counters = sweepSessionSampleDirectories(root, (pid) => pid === process.pid);

    await expect(stat(alive)).resolves.toBeDefined();
    expect(counters.removed).toBe(0);
    expect(counters.skippedAlive).toBe(1);
    expect(counters.skippedLegacy).toBe(0);
    expect(counters.unreadable).toBe(0);
  });

  it("creates PID+epoch names and tears down exactly its own directory", async () => {
    const root = await makeRoot();
    const before = sessionSampleGcSummary();
    const created = createSessionSampleDirectory(root);
    expect(created).toMatch(new RegExp(`/pi-vcc-sessions-${process.pid}-\\d+$`));

    await cleanupCreatedSessionSampleDirectories();

    await expect(stat(created)).rejects.toThrow();
    expect(sessionSampleGcSummary().removed).toBe(before.removed + 1);
  });

  it("counts cleanup failures without throwing", async () => {
    const root = await makeRoot();
    const created = createSessionSampleDirectory(root);
    await rm(created, { recursive: true });
    const before = sessionSampleGcSummary();

    await expect(cleanupCreatedSessionSampleDirectories()).resolves.toBeUndefined();

    expect(sessionSampleGcSummary().unreadable).toBe(before.unreadable + 1);
  });

  it("prints all counters, including zero-valued skips", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    printSessionSampleGcSummary();
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/removed=\d+ skipped-legacy=\d+ skipped-alive=\d+ unreadable=\d+ legacy-bytes=\d+/),
    );
    log.mockRestore();
  });
});
