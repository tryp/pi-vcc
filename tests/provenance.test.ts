/**
 * Provenance guarantees for extension-injected messages.
 *
 * The bug these pin: `convertToLlm` flattens every extension message to
 * `role: "user"` and drops customType, so pi-vcc's compaction summary presented
 * a subagent's intercom ask, a background-job completion, and an LSP auto-diag
 * as if the human had typed them — and `extractGoals` then recorded the intercom
 * ask as the session goal.
 *
 * Each test below reverts one guarantee, so a future simplification that
 * reintroduces the bug fails here rather than in a summary.
 */

import { describe, it, expect } from "bun:test";
import { describeCustom, labelToken, shortSessionId } from "../src/core/provenance";
import { normalize } from "../src/core/normalize";
import { filterNoise } from "../src/core/filter-noise";
import { compileBrief, buildBriefSections } from "../src/core/brief";
import { compileRanked } from "../src/core/summarize";
import { buildSections } from "../src/core/build-sections";
import { rankBriefBlocks } from "../src/core/rank";

const asAny = (v: unknown) => v as any;

/**
 * Body lines the brief attributes to each speaker. This is the actual
 * guarantee: a blunt `not.toContain("[user]")` would fail a session that
 * legitimately has a human turn, which is most of them.
 */
const bodiesByHeader = (brief: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  let header: string | null = null;
  for (const line of brief.split("\n")) {
    const m = /^\[([^\]]+)\]\s*$/.exec(line);
    if (m) {
      header = m[1]!;
      if (!out.has(header)) out.set(header, []);
      continue;
    }
    if (header) out.get(header)!.push(line);
  }
  return out;
};

// Real payloads taken from session files, so field paths stay pinned to what
// pi-subagents / pi-tau actually attach.
const supervisorAsk = {
  role: "custom",
  customType: "subagent_supervisor_request",
  content:
    "Subagent needs a supervisor decision.\nRun: 7beb40a4\nAgent: worker\nChild index: 0\n\nThe requested context.md and plan.md are absent.",
  details: {
    requestId: "044e8bf9-dc2c-4e06-80bc-6e709347877d",
    id: "044e8bf9-dc2c-4e06-80bc-6e709347877d",
    reason: "need_decision",
    expectsReply: true,
    runId: "7beb40a4",
    agent: "worker",
    childIndex: 0,
  },
};

const supervisorProgress = {
  ...supervisorAsk,
  details: {
    ...supervisorAsk.details,
    reason: "progress_update",
    expectsReply: false,
    requestId: "3ea7bd6f-0000-4000-8000-000000000000",
  },
  content: "Subagent progress update.\n\nUPDATE: Added no-op/cancel coverage.",
};

const notify = {
  role: "custom",
  customType: "subagent-notify",
  content: "Background task completed: **worker**\n\nworker:\n**Stale-usage repro confirmed.** The script is deterministic.",
  details: {
    version: 1,
    completions: [{ runId: "45b551d7", agent: "worker", status: "completed" }],
  },
};

// A peer ask that owes a reply: pi-intercom attaches `replyCommand` and sets
// `message.expectsReply`. 741 of 14,679 corpus intercom messages look like this.
const intercomAsk = {
  role: "custom",
  customType: "intercom_message",
  content:
    "**From subagent-chat-01a12e00-373e-7d8f** (/home/dev/src/pi-session-analysis)\n\n" +
    'To reply, use the intercom tool: intercom({ action: "reply", replyTo: "62518e8c", message: "..." })\n\n_is it landed?_',
  details: {
    bodyText: "is it landed?",
    from: {
      id: "01a12e00-373e-7d8f-b307-0ec073734dbb",
      name: "subagent-chat-01a12e00-373e-7d8f",
      cwd: "/home/dev/src/pi-session-analysis",
    },
    message: { id: "62518e8c-bf4b-40d2-8788-1053a99e1910", expectsReply: true, senderSequence: 1 },
    replyCommand: 'intercom({ action: "reply", replyTo: "62518e8c-bf4b-40d2-8788-1053a99e1910", message: "..." })',
  },
};

// The common case: a peer notice that owes nothing (13,938 of 14,679).
const intercomMessage = {
  role: "custom",
  customType: "intercom_message",
  content: "**From subagent-chat-01a12e00-373e-7d8f** (/home/dev/src/pi-session-analysis)\n\nheads up",
  details: {
    from: {
      id: "01a12e00-373e-7d8f-b307-0ec073734dbb",
      name: "subagent-chat-01a12e00-373e-7d8f",
      cwd: "/home/dev/src/pi-session-analysis",
    },
    message: { id: "5329ef3c-53a4-4aaa-bb6e-a9923a9d802c", senderSequence: 1 },
  },
};

const jobCompletion = {
  role: "custom",
  customType: "job-completion",
  content: "✅ tmux-612613-98 completed (6s), exit 0\nCommand: npx vitest run test/…",
  details: { jobId: "tmux-612613-98", status: "completed", exitCode: 0, duration: "6s", sourceId: "ctx_bg_x" },
};

const autoDiag = { role: "custom", customType: "auto_diag", content: "[auto-diag] agent-session.ts: 2 new error(s)\n  L2522 Cannot find name 'x'" };

describe("shortSessionId", () => {
  it("mirrors pi-intercom sessionIdPrefixes: min 8 chars, then to the next dash", () => {
    // pi-intercom: minimumLength = max(8, longestShared+1); slice to the next
    // '-' at or after that. 8 is already a boundary here.
    expect(shortSessionId("01a12e00-373e-7d8f-b307-0ec073734dbb")).toBe("01a12e00");
    expect(shortSessionId("abcdefghijkl-mnop")).toBe("abcdefghijkl");
    expect(shortSessionId("short")).toBe("short");
  });

  it("keeps an id without a boundary rather than over-slicing", () => {
    expect(shortSessionId("0123456789abcdef")).toBe("01234567");
  });

  it("ignores a dash that falls before the 8-char minimum", () => {
    // The floor is 8, so an early dash must not win the boundary: the second
    // dash at index 9 does, giving `sub-agent` rather than `sub`.
    expect(shortSessionId("sub-agent-1234-abcdef")).toBe("sub-agent");
  });
});

describe("describeCustom", () => {
  it("names the subagent, not the user", () => {
    expect(labelToken(describeCustom("subagent_supervisor_request", supervisorAsk.details)))
      .toBe("[subagent:worker]");
  });

  it("carries the reply route only when a reply is actually owed", () => {
    const owed = describeCustom("subagent_supervisor_request", supervisorAsk.details);
    expect(owed.route).toContain(`replyTo: "044e8bf9-dc2c-4e06-80bc-6e709347877d"`);
    expect(owed.route).toContain("subagent_supervisor");

    // 12,175 of 22,556 corpus requests are progress_update with
    // expectsReply:false — a route line there is pure cost.
    const progress = describeCustom("subagent_supervisor_request", supervisorProgress.details);
    expect(progress.route).toBeUndefined();
  });

  it("strips the redundant family from a parallel agent spec", () => {
    const parallel = {
      completions: [
        { agent: "parallel:worker+worker+reviewer", status: "completed" },
      ],
    };
    expect(describeCustom("subagent-notify", parallel).header).toBe("subagent:worker+worker+reviewer");
  });

  it("reports a terminal notification's status and offers no route", () => {
    const label = describeCustom("subagent-notify", notify.details);
    expect(labelToken(label)).toBe("[subagent:worker · completed]");
    expect(label.route).toBeUndefined();
  });

  it("addresses an intercom peer by id prefix", () => {
    // pi-intercom resolves exact id -> exact name -> id.startsWith. The header
    // must be a prefix of the id; `subagent-chat-…` resolves against no arm.
    const label = describeCustom("intercom_message", intercomMessage.details);
    expect(label.header).toBe("intercom:01a12e00");
    expect(label.header).not.toContain("subagent-chat");
  });

  it("replies with action:reply/replyTo, not to:<peer>", () => {
    // `to` addresses a *send*; with no `message` pi-intercom's inferAction
    // falls through to "list", so a to-only call does nothing. The producer's
    // own replyCommand is authoritative and is preferred verbatim.
    const label = describeCustom("intercom_message", intercomAsk.details);
    expect(label.route).toBe(
      `reply owed → intercom({ action: "reply", replyTo: "62518e8c-bf4b-40d2-8788-1053a99e1910", message: "..." })`,
    );
    expect(label.route).not.toContain("to:");
  });

  it("derives the intercom route from message.id when no replyCommand is attached", () => {
    const label = describeCustom("intercom_message", {
      from: { id: "01a12e00-373e-7d8f-b307-0ec073734dbb" },
      message: { id: "abcd1234", expectsReply: true },
    });
    expect(label.route).toBe(`reply owed → intercom({ action: "reply", replyTo: "abcd1234", message: "..." })`);
  });

  it("owes no route for a peer notice that expects no reply", () => {
    expect(describeCustom("intercom_message", intercomMessage.details).route).toBeUndefined();
  });

  it("falls back to the name when a peer payload carries no id", () => {
    // With no id there is no prefix arm to hit, so the header is a display
    // token only.
    expect(describeCustom("intercom_message", { from: { name: "subagent-chat-abc" } }).header)
      .toBe("intercom:subagent");
  });

  it("names a background job by its job id", () => {
    expect(labelToken(describeCustom("job-completion", jobCompletion.details)))
      .toBe("[job:tmux-612613-98 · completed]");
  });

  it("handles a payload with no details at all", () => {
    expect(labelToken(describeCustom("auto_diag", null))).toBe("[auto-diag]");
    // No structured id and no body text: honest, not a guess.
    expect(describeCustom("tau-pending-decision", null).header).toBe("job:unknown");
  });

  it("recovers a job id from the body when details carry none", () => {
    // tau-pending-decision ships no details; the id is in the message.
    const label = describeCustom(
      "tau-pending-decision",
      null,
      "A background job (tmux-3587860-178) is awaiting your decision. Use jobs or job_decide.",
    );
    expect(label.header).toBe("job:tmux-3587860-178");
  });

  it("does not invent a job id from an unrelated token", () => {
    expect(describeCustom("tau-pending-decision", null, "no ids here").header).toBe("job:unknown");
  });

  it("names every job in a batched completion", () => {
    // pi-tau batches concurrent completions with no top-level jobId (457 in
    // the corpus); the ids live in details.batch.
    const label = describeCustom("job-completion", {
      batch: [
        { jobId: "job-505106-122", status: "failed" },
        { jobId: "job-505106-123", status: "failed" },
      ],
    });
    expect(labelToken(label)).toBe("[job:job-505106-122+job-505106-123 · 2 failed]");
  });

  it("reads the agent from the producer's own template when details are absent", () => {
    // 28,611 of 72,002 notifications carry no details; the first line is a
    // fixed template written by pi-subagents (notify.ts).
    const label = describeCustom(
      "subagent-notify",
      null,
      "Background task failed: **parallel:reviewer+reviewer** (detached)\n\nboom",
    );
    expect(labelToken(label)).toBe("[subagent:reviewer+reviewer · failed]");
  });

  it("reads a grouped completion header too, dropping each taskInfo span", () => {
    // notify.ts's grouped header appends an optional taskInfo span after the
    // agent name (`**agent**${taskInfo}`); it is not part of the identity.
    const label = describeCustom(
      "subagent-notify",
      null,
      "Background tasks completed (2): **alpha** (1/2), **beta** (2/2)\n\n...",
    );
    expect(labelToken(label)).toBe("[subagent:alpha+beta · completed]");
  });

  it("fails closed: an unknown producer is never the user", () => {
    const label = describeCustom("some-future-extension", { agent: "worker" });
    expect(label.header).toBe("notification:some-future-extension");
    expect(labelToken(label)).not.toBe("[user]");
    expect(describeCustom("", null).header).toBe("notification:unknown");
  });
});

describe("normalize: guarantees convertToLlm used to provide", () => {
  it("drops a !! command excluded from provider context", () => {
    // convertToLlm returned undefined for these. Now that the hook passes raw
    // session messages, normalize has to drop them itself or a context-excluded
    // command leaks into the summary.
    const excluded = { role: "bashExecution", command: "secret-cmd", output: "SECRET_OUTPUT", exitCode: 0, excludeFromContext: true };
    expect(normalize([excluded] as any[])).toEqual([]);

    const included = { role: "bashExecution", command: "ls", output: "files", exitCode: 0, excludeFromContext: false };
    expect(normalize([included] as any[])).toEqual([
      { kind: "bash", command: "ls", output: "files", exitCode: 0, sourceIndex: 0 },
    ]);
  });

  it("keeps image parts of a custom content array", () => {
    const withImage = {
      role: "custom",
      customType: "some-future-extension",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", mimeType: "image/png", data: "xxx" },
      ],
    };
    const blocks = normalize([withImage] as any[]);
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as any).text).toContain("look at this");
    expect((blocks[0] as any).text).toContain("[image: image/png]");
  });
});

describe("brief rendering", () => {
  it("never renders an extension message as [user]", () => {
    const brief = compileBrief(normalize([supervisorAsk, notify, intercomMessage, jobCompletion, autoDiag] as any[]));
    expect(brief).not.toContain("[user]");
    expect(brief).toContain("[subagent:worker]");
    expect(brief).toContain("[intercom:01a12e00]");
    expect(brief).toContain("[job:tmux-612613-98 · completed]");
    expect(brief).toContain("[auto-diag]");
  });

  it("puts the reply route on the ask, ahead of its body", () => {
    const brief = compileBrief(normalize([supervisorAsk] as any[]));
    expect(brief.indexOf("reply owed")).toBeLessThan(brief.indexOf("Subagent needs a supervisor decision"));
  });

  it("keeps consecutive same-source messages in one section", () => {
    const sections = buildBriefSections(normalize([supervisorProgress, supervisorProgress] as any[]));
    const custom = sections.filter((s) => s.header === "[subagent:worker]");
    expect(custom).toHaveLength(1);
    expect(custom[0].lines.length).toBeGreaterThan(1);
  });

  it("distinguishes two different subagents", () => {
    const other = { ...supervisorProgress, details: { ...supervisorProgress.details, agent: "reviewer" } };
    const sections = buildBriefSections(normalize([supervisorProgress, other] as any[]));
    expect(sections.map((s) => s.header)).toContain("[subagent:worker]");
    expect(sections.map((s) => s.header)).toContain("[subagent:reviewer]");
  });

  it("does not leak customType away when filterNoise strips wrapper tags", () => {
    const wrapped = {
      role: "custom",
      customType: "subagent_supervisor_request",
      content: "<system-reminder>x</system-reminder>real content",
      details: supervisorAsk.details,
    };
    const out = filterNoise(normalize([wrapped] as any[]));
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("custom");
    expect((out[0] as any).customType).toBe("subagent_supervisor_request");
  });

  it("drops an empty custom message (the invisible auto-continue marker)", () => {
    const marker = { role: "custom", customType: "pi-vcc-auto-continue", content: [] };
    expect(filterNoise(normalize([marker] as any[]))).toEqual([]);
  });
});

describe("ranking", () => {
  it("keeps a notification below the human turn it is answering", () => {
    // Under the brief's char budget the user turn must survive and the
    // notification must be the first thing dropped: a subagent's reply is
    // context, not the conversation's spine.
    const blocks = normalize([
      { role: "user", content: "Investigate the stale retention anchor and tell me why it survives a rebuild." },
      notify,
      { role: "assistant", content: "Reading compaction.ts now to confirm the anchor retention path." },
    ] as any[]);
    const ranked = rankBriefBlocks(blocks);
    const user = ranked.find((r) => r.block.kind === "user")!;
    const custom = ranked.find((r) => r.block.kind === "custom")!;
    expect(custom.score).toBeLessThan(user.score);
    expect(custom.reasons).toContain("extension-notification");
  });
});

describe("section extraction", () => {
  it("never records an extension message as the session goal", () => {
    // The live failure mode: a subagent's progress update arrived first in the
    // window, matched TASK_RE, and became the goal — displacing what the human
    // actually asked for (the goal list is capped at 8).
    const blocks = normalize([
      {
        role: "custom",
        customType: "subagent_supervisor_request",
        content:
          "Subagent progress update.\n\nUPDATE: Implemented the stale-usage fix and added regression tests.\nAlso refactored the compaction path.",
        details: { agent: "worker", expectsReply: false },
      },
      { role: "user", content: "Investigate why the retention anchor is stale." },
    ] as any[]);
    const goal = buildSections({ blocks }).sessionGoal.join("\n");
    expect(goal).not.toContain("Implemented the stale-usage fix");
    expect(goal).not.toContain("UPDATE:");
    expect(goal).toContain("Investigate why the retention anchor is stale.");
  });

  it("keeps an intercom ask out of [Session Goal]", () => {
    const blocks = normalize([
      { role: "user", content: "Investigate why the retention anchor is stale." },
      supervisorAsk,
    ] as any[]);
    const data = buildSections({ blocks });
    expect(data.sessionGoal.join("\n")).toContain("Investigate why the retention anchor");
    expect(data.sessionGoal.join("\n")).not.toContain("Subagent needs a supervisor decision");
    expect(data.sessionGoal.join("\n")).not.toContain("Reply with:");
  });

  it("keeps an intercom ask out of [User Preferences]", () => {
    const blocks = normalize([
      { role: "user", content: "Always use rg before grep." },
      {
        role: "custom",
        customType: "subagent-notify",
        content: "worker: prefer using sed for line ranges in future work.",
        details: { completions: [{ agent: "worker", status: "completed" }] },
      },
    ] as any[]);
    const data = buildSections({ blocks });
    expect(data.userPreferences.join("\n")).not.toContain("prefer using sed");
  });

  it("attributes a subagent's blocker to the subagent, not [user]", () => {
    const blocked = {
      role: "custom",
      customType: "subagent-notify",
      content: "worker:\nBuild is still failing because the fixture is missing.",
      details: { completions: [{ agent: "worker", status: "failed" }] },
    };
    const data = buildSections({ blocks: normalize([blocked] as any[]) });
    expect(data.outstandingContext.join("\n")).toContain("[subagent:worker · failed]");
    expect(data.outstandingContext.join("\n")).not.toContain("[user]");
  });
});

describe("end-to-end compileRanked", () => {
  it("compiles a session whose only human turn is one line", () => {
    const summary = compileRanked({
      messages: [
        { role: "user", content: "Investigate the stale retention anchor." },
        { role: "assistant", content: "Reading compaction.ts now.", stopReason: "stop", usage: {} as any, provider: {}, model: "m", api: "" as any, timestamp: 1 },
        supervisorAsk,
        { role: "assistant", content: "Confirmed and fixing.", stopReason: "stop", usage: {} as any, provider: {}, model: "m", api: "" as any, timestamp: 2 },
        notify,
        jobCompletion,
        autoDiag,
      ] as any[],
    });
    expect(summary).toContain("[subagent:worker]");
    expect(summary).toContain("[job:tmux-612613-98");
    expect(summary).toContain("[auto-diag]");

    // The real guarantee: nothing an extension said sits under [user].
    const bodies = bodiesByHeader(summary);
    const userBody = (bodies.get("user") ?? []).join("\n");
    expect(userBody).toContain("Investigate the stale retention anchor");
    expect(userBody).not.toContain("Subagent needs a supervisor decision");
    expect(userBody).not.toContain("Background task completed");
    expect(userBody).not.toContain("tmux-612613-98");
    expect(userBody).not.toContain("auto-diag");

    // The ask that used to be logged as the session goal.
    expect((bodies.get("Session Goal") ?? []).join("\n"))
      .toContain("Investigate the stale retention anchor");
    expect((bodies.get("Session Goal") ?? []).join("\n"))
      .not.toContain("Subagent needs a supervisor decision");
  });

  it("still renders a real human turn as [user]", () => {
    const summary = compileRanked({
      messages: [
        { role: "user", content: "Investigate the stale retention anchor." },
        { role: "assistant", content: "Reading compaction.ts now.", stopReason: "stop", usage: {} as any, provider: {}, model: "m", api: "" as any, timestamp: 1 },
        { role: "user", content: "Now write the regression test." },
      ] as any[],
    });
    expect(summary).toContain("[user]");
    expect(summary).toContain("Investigate the stale retention anchor");
  });
});