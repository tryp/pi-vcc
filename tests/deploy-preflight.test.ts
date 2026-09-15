import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function preflightFromEnvironment(source: string, runtime: string) {
  return spawnSync("make", ["--no-print-directory", "deploy-preflight"], {
    cwd: repo,
    env: { ...process.env, SOURCE: source, RUNTIME: runtime },
  });
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

  test("accepts source and runtime paths containing whitespace", () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-vcc deploy paths-"));
    fixtures.push(parent);
    const source = fixture(parent);
    const runtime = mkdtempSync(join(parent, "pi-vcc runtime-"));
    fixtures.push(runtime);
    const result = preflight(source, runtime);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.match(result.stdout.toString(), /deploy preflight passed/);
  });

  test("preserves dollar signs and Make metacharacters in environment path overrides", () => {
    const parent = mkdtempSync(join(tmpdir(), "pi-vcc make paths-"));
    fixtures.push(parent);
    const marker = join(repo, `tmp-pi-vcc-env-injection-${process.pid}`);
    rmSync(marker, { force: true });
    const source = fixture(parent);
    const sourceWithSpecials = `${source}$#:=%; touch ${marker.slice(repo.length + 1)};?*;`;
    renameSync(source, sourceWithSpecials);
    fixtures[fixtures.length - 1] = sourceWithSpecials;
    const runtime = mkdtempSync(join(parent, "pi-vcc runtime-"));
    const runtimeWithSpecials = `${runtime}$#:=%;?*;`;
    renameSync(runtime, runtimeWithSpecials);
    fixtures.push(runtimeWithSpecials);

    try {
      const result = preflightFromEnvironment(sourceWithSpecials, runtimeWithSpecials);
      assert.equal(result.status, 0, result.stderr.toString());
      assert.match(result.stdout.toString(), /deploy preflight passed/);
      assert.equal(existsSync(marker), false, result.stdout.toString() + result.stderr.toString());
    } finally {
      rmSync(marker, { force: true });
    }
  });

  test("rejects source path overrides containing newline or carriage return", () => {
    for (const suffix of ["\n", "\r"]) {
      const source = fixture();
      const renamedSource = `${source}${suffix}`;
      renameSync(source, renamedSource);
      fixtures[fixtures.length - 1] = renamedSource;
      const runtime = mkdtempSync(join(tmpdir(), "pi-vcc-deploy-runtime-"));
      fixtures.push(runtime);
      const result = preflight(renamedSource, runtime);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr.toString(), /SOURCE path override contains newline or carriage return/);
    }
  });

  test("does not execute shell metacharacters in path overrides", () => {
    const marker = join(tmpdir(), `pi-vcc-preflight-injection-${process.pid}`);
    rmSync(marker, { force: true });
    const source = `${join(tmpdir(), "pi-vcc nonexistent")}"; touch "${marker}`;
    const runtime = join(tmpdir(), "pi-vcc runtime");
    try {
      const result = preflight(source, runtime);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(marker), false, result.stdout.toString() + result.stderr.toString());
    } finally {
      rmSync(marker, { force: true });
    }
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
