/**
 * e2e-provenance — load the candidate pi-vcc in a REAL pi process and run a
 * synthetic `session_before_compact` through the hook it actually registered.
 *
 * Unit tests call `registerBeforeCompactHook` on a hand-written stub. This
 * check exists because a stub cannot observe the two things that broke:
 *
 *   1. The hook flattening its input with `convertToLlm` before summarizing.
 *      A stub that never calls convertToLlm cannot notice its removal.
 *   2. A real session message arriving as `role: "custom"` with a
 *      `customType`, rather than as a pi-ai provider message.
 *
 * So this drives the registered handler, in-process with real pi, against
 * payloads copied verbatim from session files, and prints the summary the
 * extension would really emit. Run it via `make e2e-provenance`; it exits
 * non-zero if any extension message is attributed to the user.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION } from "../src/hooks/before-compact";

const M = (id: string, role: string, content: string) => ({ id, type: "message", message: { role, content } });

const CUSTOM = (id: string, customType: string, content: string, details: unknown) => ({
  id,
  type: "custom_message",
  customType,
  content,
  display: true,
  details,
  timestamp: "2026-10-12T05:00:00.000Z",
});

// Copied from real session files: same customTypes, same details field paths.
const BRANCH_ENTRIES = [
  M("u1", "user", "Investigate why the retained context estimate stays above 170k after a rebuild."),
  M("a1", "assistant", "Reading the compaction and session-manager paths now."),
  CUSTOM(
    "c1",
    "subagent_supervisor_request",
    "Subagent needs a supervisor decision.\nRun: 7beb40a4-df48-4fee-b170-697e93a67a3d\nAgent: worker\nChild index: 0\n\n" +
      "The requested context.md and plan.md are absent from the supplied accounting worktree. Please provide their paths or confirm I should proceed without them.",
    {
      requestId: "044e8bf9-dc2c-4e06-80bc-6e709347877d",
      id: "044e8bf9-dc2c-4e06-80bc-6e709347877d",
      reason: "need_decision",
      expectsReply: true,
      runId: "7beb40a4-df48-4fee-b170-697e93a67a3d",
      agent: "worker",
      childIndex: 0,
    },
  ),
  M("a2", "assistant", "Traced the estimate path and found the stale usage anchor."),
  CUSTOM(
    "c2",
    "intercom_message",
    "**From subagent-chat-01a12e00-373e-7d8f** (/home/dev/src/pi-session-analysis)\n\n" +
      "_id 5329ef3c · seq 1 · sent 2026-10-12T05:22:19.933Z_\n\nUser asks: is the estimate fix landed yet?",
    {
      from: {
        id: "01a12e00-373e-7d8f-b307-0ec073734dbb",
        name: "subagent-chat-01a12e00-373e-7d8f",
        cwd: "/home/dev/src/pi-session-analysis",
      },
      message: { id: "62518e8c-bf4b-40d2-8788-1053a99e1910", expectsReply: true, senderSequence: 1 },
      replyCommand: 'intercom({ action: "reply", replyTo: "62518e8c-bf4b-40d2-8788-1053a99e1910", message: "..." })',
    },
  ),
  CUSTOM(
    "c3",
    "subagent-notify",
    "Background task completed: **worker**\n\nworker:\n**Stale-usage repro confirmed.** The retained assistant still anchors the estimate.",
    { version: 1, completions: [{ runId: "45b551d7", agent: "worker", status: "completed" }] },
  ),
  CUSTOM(
    "c4",
    "job-completion",
    "✅ tmux-612613-98 completed (6s), exit 0\nCommand: npx vitest run test/provider-context-estimate.test.ts",
    { jobId: "tmux-612613-98", status: "completed", exitCode: 0, duration: "6s", sourceId: "ctx_bg_x" },
  ),
  CUSTOM("c5", "auto_diag", "[auto-diag] agent-session.ts: 2 new error(s)\n  L2522 (2304) Cannot find name 'estimateProviderContextTokens'", null),
  M("a3", "assistant", "Applying the fix and re-running the focused test."),
];

const SENTINELS = [
  "needs a supervisor decision",
  "From subagent-chat",
  "Stale-usage repro confirmed",
  "tmux-612613-98 completed",
  "agent-session.ts: 2 new error",
];

export default function e2eProvenance(pi: ExtensionAPI) {
  const captured: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  const realOn = pi.on.bind(pi);
  (pi as unknown as { on: (n: string, h: unknown) => void }).on = (name: string, handler: unknown) => {
    captured[name] = handler as (event: unknown, ctx: unknown) => unknown;
    return realOn(name as never, handler as never);
  };

  registerBeforeCompactHook(pi);

  const before = captured["session_before_compact"];
  if (!before) {
    console.error("E2E_PROVENANCE_FAIL: hook did not register session_before_compact");
    process.exitCode = 1;
    return;
  }

  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const ctx = { hasUI: false, ui: { notify: (msg: string, level: string) => events.push({ kind: "notify", data: { msg, level } }) } };

  const result = before(
    {
      type: "session_before_compact",
      customInstructions: PI_VCC_COMPACT_INSTRUCTION,
      branchEntries: BRANCH_ENTRIES,
      preparation: { previousSummary: undefined, fileOps: { read: [], written: [], edited: [] }, tokensBefore: 100_000 },
      signal: new AbortController().signal,
      reason: "manual",
      willRetry: false,
    },
    ctx,
  ) as { cancel?: boolean; compaction?: { summary: string } } | undefined;

  if (!result || result.cancel || !result.compaction) {
    console.error(`E2E_PROVENANCE_FAIL: hook returned ${JSON.stringify(result ?? null)}`);
    process.exitCode = 1;
    return;
  }

  const summary = result.compaction.summary;
  const failures: string[] = [];

  // 1. No extension message sits under a [user] header.
  let header = "";
  const userBody: string[] = [];
  for (const line of summary.split("\n")) {
    const h = /^\[([^\]]+)\]\s*$/.exec(line);
    if (h) { header = h[1]!; continue; }
    if (header === "user") userBody.push(line);
  }
  for (const sentinel of SENTINELS) {
    if (userBody.join("\n").includes(sentinel)) failures.push(`attributed to [user]: ${sentinel}`);
  }

  // 2. Every producer is named.
  for (const expected of ["[subagent:worker", "[intercom:01a12e00]", "[job:tmux-612613-98", "[auto-diag]"]) {
    if (!summary.includes(expected)) failures.push(`missing label: ${expected}`);
  }

  // 3. Both pending asks carry a reply route, and the intercom one names the
  //    call pi-intercom actually accepts (`action:"reply", replyTo:<message.id>`)
  //    rather than `to:<peer>`, which infers "list" and does nothing.
  const routes = summary.split("\n").filter((l) => l.includes("reply owed"));
  if (routes.length !== 2) failures.push(`expected 2 reply routes, found ${routes.length}`);
  if (!summary.includes(`subagent_supervisor({ action: "reply", replyTo: "044e8bf9`)) {
    failures.push("supervisor reply route missing or malformed");
  }
  if (!summary.includes(`intercom({ action: "reply", replyTo: "62518e8c`)) {
    failures.push("intercom reply route missing or malformed");
  }
  if (/reply owed.*intercom\(\{ to:/.test(summary)) failures.push("intercom route uses to:<peer>");

  // 4. The human goal is not displaced by the ask.
  const goalStart = summary.indexOf("[Session Goal]");
  const goal = goalStart < 0 ? "" : summary.slice(goalStart, summary.indexOf("\n\n---\n\n", goalStart));
  if (!goal.includes("Investigate why the retained context estimate")) {
    failures.push("human goal missing from [Session Goal]");
  }
  if (goal.includes("needs a supervisor decision")) {
    failures.push("[Session Goal] contains the intercom ask");
  }

  console.log("---- summary emitted by the loaded extension ----");
  console.log(summary);
  console.log("---- checks ----");
  console.log(`[user] body lines:   ${userBody.filter(Boolean).length}`);
  console.log(`reply routes:        ${routes.length}`);
  console.log(`producers labelled:  ${["subagent:worker", "intercom:01a12e00", "job:tmux-612613-98", "auto-diag"].every((l) => summary.includes(l))}`);

  if (failures.length > 0) {
    console.error(`E2E_PROVENANCE_FAIL: ${failures.length} check(s) failed`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("E2E_PROVENANCE_PASS");
}
