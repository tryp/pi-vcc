import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtures: string[] = [];

const PACKAGES = ["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"];

/**
 * Environment keys the repo Makefile exports to every recipe
 * (`export ... PI_MONO PI_CODING_AGENT PI_AI PI_AGENT_CORE PI_TUI`).
 *
 * Because of that export, running the suite from any make recipe — e.g.
 * `make test-suite` — leaks resolved package paths into `process.env`, and the
 * child `make` in the fixture then sees a directory override for PI_AI that
 * outranks the fixture's own PI_MONO. This test's whole subject is which
 * override wins, so it has to control inheritance rather than spread it.
 */
const LEAKED_OVERRIDES = ["PI_MONO", "PI_CODING_AGENT", "PI_AI", "PI_AGENT_CORE", "PI_TUI"];

function cleanEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of LEAKED_OVERRIDES) delete base[key];
  return { ...base, ...env };
}

/**
 * A throwaway checkout carrying the real Makefile, plus a fake pi-mono that
 * provides the packages link-packages resolves. Keeping both in a temp dir
 * makes the test independent of the host's pi-mono checkout and safe to mutate.
 */
function fixture(): { root: string; piMono: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-vcc-link-"));
  fixtures.push(root);
  writeFileSync(join(root, "Makefile"), readFileSync(join(repo, "Makefile")));
  const piMono = join(root, "pi-mono");
  for (const name of PACKAGES) {
    mkdirSync(join(piMono, "node_modules", "@earendil-works", name), { recursive: true });
  }
  return { root, piMono };
}

function linkPackages(root: string, env: Record<string, string>) {
  return spawnSync("make", ["--no-print-directory", "link-packages"], {
    cwd: root,
    env: cleanEnv(env),
    encoding: "utf8",
  });
}

function dependencyLink(root: string, name: string): string {
  return readlinkSync(join(root, "node_modules", "@earendil-works", name));
}

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("link-packages dependency overrides", () => {
  // The pi harness exports PI_CODING_AGENT=true for its own purposes. With a
  // plain `?=` default that value wins over the intended path, and `ln -sfn`
  // creates a symlink to the literal string, leaving node_modules corrupt for
  // every later target that resolves imports through it.
  test("ignores an inherited non-directory value and links the default", () => {
    const { root, piMono } = fixture();
    const result = linkPackages(root, { PI_MONO: piMono, PI_CODING_AGENT: "true" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /ignoring PI_CODING_AGENT=true: not a directory/);
    for (const name of PACKAGES) {
      assert.equal(dependencyLink(root, name), join(piMono, "node_modules", "@earendil-works", name));
    }
    assert.equal(
      readlinkSync(join(root, "node_modules", "@mariozechner", "pi-coding-agent")),
      join(piMono, "node_modules", "@earendil-works", "pi-coding-agent"),
    );
  });

  test("honours a directory override without warning", () => {
    const { root, piMono } = fixture();
    const custom = join(root, "custom-coding-agent");
    mkdirSync(custom);
    const result = linkPackages(root, { PI_MONO: piMono, PI_CODING_AGENT: custom });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /ignoring PI_CODING_AGENT/);
    assert.equal(dependencyLink(root, "pi-coding-agent"), custom);
  });

  test("fails loudly when a resolved dependency is missing", () => {
    const { root, piMono } = fixture();
    rmSync(join(piMono, "node_modules", "@earendil-works", "pi-ai"), { recursive: true, force: true });
    const result = linkPackages(root, { PI_MONO: piMono });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERROR: PI_AI=.*is not a directory/);
  });
});
