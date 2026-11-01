import {
  chmod,
  copyFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const SESSION_ROOT = join(process.env.HOME ?? "", ".pi/agent/sessions");
const PREFIX = "pi-vcc-sessions-";
const ATTRIBUTABLE_NAME = /^pi-vcc-sessions-(\d+)-(\d+)$/;

export interface SessionSample {
  source: string;
  copy: string;
  size: number;
  mtimeMs: number;
}

export interface FixtureGcCounters {
  removed: number;
  skippedLegacy: number;
  skippedAlive: number;
  unreadable: number;
  legacyBytes: number;
}

const emptyCounters = (): FixtureGcCounters => ({
  removed: 0,
  skippedLegacy: 0,
  skippedAlive: 0,
  unreadable: 0,
  legacyBytes: 0,
});

const fixtureDirectories = new Set<string>();

const directoryBytes = (path: string, counters: FixtureGcCounters): number => {
  let bytes = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    counters.unreadable++;
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) bytes += directoryBytes(child, counters);
      else if (entry.isFile()) bytes += statSync(child).size;
    } catch {
      counters.unreadable++;
    }
  }
  return bytes;
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    throw error;
  }
};

/** Sweep only directories with the new PID+epoch name; legacy names are report-only. */
export const sweepSessionSampleDirectories = (
  root = tmpdir(),
  isAlive: (pid: number) => boolean = processIsAlive,
): FixtureGcCounters => {
  const counters = emptyCounters();
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    counters.unreadable++;
    return counters;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue;
    const path = join(root, entry.name);
    const match = ATTRIBUTABLE_NAME.exec(entry.name);
    if (!match) {
      counters.skippedLegacy++;
      counters.legacyBytes += directoryBytes(path, counters);
      continue;
    }

    const pid = Number(match[1]);
    try {
      if (isAlive(pid)) {
        counters.skippedAlive++;
        continue;
      }
      rmSync(path, { recursive: true });
      counters.removed++;
    } catch {
      counters.unreadable++;
    }
  }
  return counters;
};

const startupCounters = sweepSessionSampleDirectories();
const runCounters = { ...startupCounters };

/** Create and track a uniquely attributable directory for this process. */
export const createSessionSampleDirectory = (root = tmpdir()): string => {
  let epoch = Date.now();
  while (true) {
    const path = join(root, `${PREFIX}${process.pid}-${epoch}`);
    try {
      mkdirSync(path);
      fixtureDirectories.add(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      epoch++;
    }
  }
};

/** Remove only directories created by this process; cleanup failures are counted, not thrown. */
export const cleanupCreatedSessionSampleDirectories = async (): Promise<void> => {
  for (const path of fixtureDirectories) {
    try {
      await rm(path, { recursive: true });
      runCounters.removed++;
    } catch {
      runCounters.unreadable++;
    } finally {
      fixtureDirectories.delete(path);
    }
  }
};

/** Startup-sweep plus this run's teardown counters, including visible zeroes. */
export const sessionSampleGcSummary = (): FixtureGcCounters => ({ ...runCounters });

export const printSessionSampleGcSummary = (): void => {
  const counters = sessionSampleGcSummary();
  console.log(
    `[pi-vcc fixture GC] removed=${counters.removed} skipped-legacy=${counters.skippedLegacy} skipped-alive=${counters.skippedAlive} unreadable=${counters.unreadable} legacy-bytes=${counters.legacyBytes}`,
  );
};

const walk = async (dir: string): Promise<string[]> => {
  const names = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name.name);
    if (name.isDirectory()) out.push(...await walk(path));
    else if (name.isFile() && path.endsWith(".jsonl")) out.push(path);
  }
  return out;
};

const pickLargest = async (limit: number): Promise<string[]> => {
  const files = await walk(SESSION_ROOT);
  const sized = await Promise.all(
    files.map(async (file) => ({ file, size: (await stat(file)).size })),
  );
  return sized.sort((a, b) => b.size - a.size).slice(0, limit).map((x) => x.file);
};

export const prepareSessionSamples = async (limit = 2): Promise<SessionSample[]> => {
  const selected = await pickLargest(limit);
  const dir = createSessionSampleDirectory();
  const samples: SessionSample[] = [];
  for (const source of selected) {
    const srcStat = await stat(source);
    const copy = join(dir, basename(source));
    await copyFile(source, copy);
    await chmod(copy, 0o444);
    samples.push({ source, copy, size: srcStat.size, mtimeMs: srcStat.mtimeMs });
  }
  return samples;
};

export const readSourceStat = async (sample: SessionSample) => {
  const s = await stat(sample.source);
  return { size: s.size, mtimeMs: s.mtimeMs };
};
