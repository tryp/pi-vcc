#!/usr/bin/env python3
"""
mutcheck-provenance -- revert each provenance guarantee and require a test to fail.

A test that only pins a rendered string can pass while the measurement behind it
is wrong. Each mutation below removes exactly one guarantee; if the suite stays
green, that guarantee is unobserved and the fix it protects is not protected.

Two failure modes of the harness itself are treated as errors rather than as
passes, because both would otherwise be reported as "caught":

  - a mutation that does not change the file (a stale `old` string), and
  - a mutation that does not compile (it fails every test for the wrong reason).

Only a syntactically valid mutation that makes a test fail counts as caught.

Usage: make mutcheck-provenance   (or: python3 scripts/mutcheck-provenance.py)
"""

from __future__ import annotations

import hashlib
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
TESTS = ["tests/provenance.test.ts", "tests/before-compact-hook.test.ts"]

# (description, file, old, new)
MUTATIONS: list[tuple[str, str, str, str]] = [
    (
        "unknown customType falls back to [user] (fail-open)",
        "src/core/provenance.ts",
        'return { header: `notification:${customType || "unknown"}` };',
        'return { header: "user" };',
    ),
    (
        "intercom label uses the display name instead of the id prefix",
        "src/core/provenance.ts",
        "id ? shortSessionId(id) : name ? shortSessionId(name) : \"peer\"",
        "name ?? (id ? shortSessionId(id) : \"peer\")",
    ),
    (
        "shortSessionId honours a dash before the 8-char floor",
        "src/core/provenance.ts",
        'id.indexOf("-", MIN)',
        'id.indexOf("-", 1)',
    ),
    (
        "reply route emitted for progress updates (expectsReply ignored)",
        "src/core/provenance.ts",
        "...(expectsReply && requestId",
        "...((!expectsReply) && requestId",
    ),
    (
        "intercom route uses to:<peer> instead of action:reply/replyTo",
        "src/core/provenance.ts",
        "? `reply owed → ${replyCommand}`",
        '? `reply owed → intercom({ to: "${name}" })`',
    ),
    (
        "intercom route emitted even when no reply is owed",
        "src/core/provenance.ts",
        "const route = !expectsReply",
        "const route = false",
    ),
    (
        "job id not recovered from the body when details lack one",
        "src/core/provenance.ts",
        "asString(details?.jobId) ?? jobIdFromText(text)",
        "asString(details?.jobId)",
    ),
    (
        "batched job completion loses its ids",
        "src/core/provenance.ts",
        "if (batch.length > 0) {",
        "if (false) {",
    ),
    (
        "notify agent name not recovered from the producer template",
        "src/core/provenance.ts",
        "if (agents.length === 0 && text) {",
        "if (false) {",
    ),
    (
        "notify group header keeps the taskInfo span in the agent name",
        "src/core/provenance.ts",
        '.replace(/\\s*\\([^)]*\\)\\s*$/, "")',
        "",
    ),
    (
        "brief renders a custom block under [user]",
        "src/core/brief.ts",
        "const header = labelToken(label);",
        'const header = "[user]";',
    ),
    (
        "reply route line dropped",
        "src/core/brief.ts",
        "if (label.route) push(header, label.route);",
        "",
    ),
    (
        "filterNoise rewrites custom -> user (the original provenance loss)",
        "src/core/filter-noise.ts",
        "out.push({ ...b, text: cleaned });",
        'out.push({ kind: "user", text: cleaned });',
    ),
    (
        "custom messages skipped entirely",
        "src/core/normalize.ts",
        'if (role === "custom") {',
        "if (false) {",
    ),
    (
        "branch summaries dropped instead of re-wrapped",
        "src/core/normalize.ts",
        'if (role === "branchSummary" || role === "compactionSummary") {',
        "if (false) {",
    ),
    (
        "!! excluded-from-context command leaked into the summary",
        "src/core/normalize.ts",
        "if (m.excludeFromContext) return [];",
        "",
    ),
    (
        "custom image parts dropped",
        "src/core/normalize.ts",
        '(part as { type?: unknown }).type === "image"',
        '(part as { type?: unknown }).type === "__not_image__"',
    ),
    (
        "goal extraction re-admits custom blocks (Session Goal pollution)",
        "src/extract/goals.ts",
        'if (b.kind !== "user") continue;',
        'if (b.kind !== "user" && b.kind !== "custom") continue;',
    ),
    (
        "outstanding context attributes a subagent blocker to [user]",
        "src/core/build-sections.ts",
        'b.kind === "custom" ? labelToken(describeCustom(b.customType, b.details, b.text)) : ""',
        '""',
    ),
    (
        "custom blocks ranked as user turns",
        "src/core/rank.ts",
        'if (block.kind === "custom") add(ranked, 8, "extension-notification");',
        'if (block.kind === "custom") add(ranked, 18, "extension-notification");',
    ),
]


def tree_hash() -> str:
    digest = hashlib.sha256()
    for path in sorted(SRC.rglob("*.ts")):
        digest.update(path.relative_to(SRC).as_posix().encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def compiles(rel: str) -> bool:
    proc = subprocess.run(
        ["bun", "build", rel, "--target=node", "--outfile=/dev/null"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def suite_green() -> bool:
    proc = subprocess.run(
        ["bun", "test", *TESTS],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0


def main() -> int:
    backup = pathlib.Path(tempfile.mkdtemp(prefix="pi-vcc-mutcheck-"))

    def restore() -> None:
        shutil.rmtree(SRC)
        shutil.copytree(backup / "src", SRC)

    shutil.copytree(SRC, backup / "src")

    caught: list[str] = []
    setup_errors: list[str] = []
    survivors: list[str] = []

    try:
        for desc, rel, old, new in MUTATIONS:
            restore()
            path = ROOT / rel
            text = path.read_text()
            if old not in text:
                setup_errors.append(f"{desc} (stale target: {old!r} not in {rel})")
                continue

            before = tree_hash()
            path.write_text(text.replace(old, new, 1))
            if tree_hash() == before:
                setup_errors.append(f"{desc} (patch was a no-op)")
                continue

            changed = [p for p in sorted(SRC.rglob("*.ts")) if not (backup / p.relative_to(ROOT)).exists() or
                       p.read_bytes() != (backup / p.relative_to(ROOT)).read_bytes()]
            bad = [str(p.relative_to(ROOT)) for p in changed if not compiles(str(p.relative_to(ROOT)))]
            if bad:
                setup_errors.append(f"{desc} (mutation does not compile: {', '.join(bad)})")
                continue

            if suite_green():
                survivors.append(desc)
                print(f"SURVIVED: {desc}", flush=True)
            else:
                caught.append(desc)
                print(f"caught:   {desc}", flush=True)
    finally:
        restore()
        shutil.rmtree(backup, ignore_errors=True)

    print()
    for err in setup_errors:
        print(f"SETUP-ERROR: {err}", file=sys.stderr)
    if survivors:
        print(f"mutcheck-provenance: {len(survivors)} mutation(s) survived — a guarantee is unobserved", file=sys.stderr)
    if setup_errors:
        print(f"mutcheck-provenance: {len(setup_errors)} mutation(s) never applied", file=sys.stderr)
    if survivors or setup_errors:
        return 1
    print(f"mutcheck-provenance: {len(caught)}/{len(MUTATIONS)} mutations caught")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
