import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures: string[] = [];

function fixture(parent = tmpdir()): string {
  const source = mkdtempSync(join(parent, "pi-vcc-deploy-source-"));
  fixtures.push(source);
  for (const dir of ["src", "scripts", "tests"]) mkdirSync(join(source, dir));
  for (const file of ["index.ts", "package.json", "tsconfig.json", "README.md"])
    writeFileSync(join(source, file), "fixture\n");
  const init = spawnSync("git", ["init", "--quiet", source]);
  if (init.status !== 0) throw new Error(init.stderr.toString());
  return source;
}

function preflight(source: string, runtime: string) {
  return spawnSync(
    "make",
    ["--no-print-directory", "deploy-preflight", `SOURCE=${source}`, `RUNTIME=${runtime}`],
    { cwd: repo },
  );
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("deploy-preflight", () => {
  test("rejects a source/runtime collision", () => {
    const source = fixture();
    const result = preflight(source, source);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /different paths/);
  });

  test("rejects a runtime descendant of the source after path normalization", () => {
    const source = fixture();
    const relativeSource = relative(repo, source);
    const runtime = `${relativeSource}/nested/../runtime`;
    const result = preflight(relativeSource, runtime);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /paths must not overlap/);
  });

  test("rejects a source descendant of the runtime", () => {
    const runtime = mkdtempSync(join(tmpdir(), "pi-vcc-deploy-runtime-"));
    fixtures.push(runtime);
    const source = fixture(runtime);
    const result = preflight(source, `${runtime}/./`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /paths must not overlap/);
  });

  test("rejects a source outside Git", () => {
    const source = fixture();
    rmSync(join(source, ".git"), { recursive: true, force: true });
    const runtime = mkdtempSync(join(tmpdir(), "pi-vcc-deploy-runtime-"));
    fixtures.push(runtime);
    const result = preflight(source, runtime);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /Git worktree/);
  });

  test("rejects nested source and runtime symlinks, including the marker", () => {
    const source = fixture();
    const runtime = mkdtempSync(join(tmpdir(), "pi-vcc-deploy-runtime-"));
    fixtures.push(runtime);

    symlinkSync("/tmp", join(source, "src", "escape"));
    let result = preflight(source, runtime);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /symlink in source/);
    rmSync(join(source, "src", "escape"));

    renameSync(join(source, "index.ts"), join(source, "index.ts.original"));
    symlinkSync("/tmp", join(source, "index.ts"));
    result = preflight(source, runtime);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /symlink source file/);
    rmSync(join(source, "index.ts"));
    renameSync(join(source, "index.ts.original"), join(source, "index.ts"));

    mkdirSync(join(runtime, "src"));
    symlinkSync("/tmp", join(runtime, "src", "escape"));
    result = preflight(source, runtime);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /symlink in runtime/);
    rmSync(join(runtime, "src", "escape"));

    symlinkSync("/tmp", join(runtime, ".deployed-commit"));
    result = preflight(source, runtime);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr.toString(), /symlink in runtime/);
  });
});
