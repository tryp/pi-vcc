/**
 * Provenance labels for extension-injected messages.
 *
 * pi converts an extension's `sendMessage()` into a session message with
 * `role: "custom"` and a `customType`. Converting those to provider input
 * flattens them to `role: "user"`, which is why a compaction summary used to
 * present a subagent's intercom ask, a background-job completion, or an LSP
 * auto-diag as if the human had typed it.
 *
 * This module derives a short, mergeable header token plus — only where a reply
 * is actually possible — the tool call that answers it. Structural fields from
 * the real `details` payload are preferred; where a producer attaches none, the
 * fallbacks match that producer's own machine-generated template (cited
 * per-site) rather than guessing at free prose.
 */

/** How a label renders in the brief, and how to answer it. */
export interface CustomLabel {
  /** Short header token, e.g. `subagent:worker`. Never the bare string `user`. */
  header: string;
  /** Terminal status appended to the header, when the payload reports one. */
  status?: string;
  /** Reply instruction. Present only on channels that accept a reply. */
  route?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const SUPERVISOR_TOOL = "subagent_supervisor";

/**
 * Shortest stable prefix of an intercom session id.
 *
 * Deterministic truncation only: at least 8 characters, then extended to the
 * next `-` boundary so the token stays readable. pi-intercom's own
 * `sessionIdPrefixes` additionally widens the floor to outrun the longest
 * shared prefix among *currently connected* peers — that cannot be recomputed
 * here, because a session file does not record who was connected when the
 * message was sent. pi-intercom stays the authority on ambiguity and reports it
 * loudly; this token is a glanceable hint, not a resolution.
 *
 * The prefix has to be a prefix of the **id**, not of the display name:
 * pi-intercom resolves exact id, then exact name, then `id.startsWith`, and
 * `01a12e00-…` does not start with `subagent-chat-`.
 */
export const shortSessionId = (id: string): string => {
  const MIN = 8;
  if (id.length <= MIN) return id;
  const boundary = id.indexOf("-", MIN);
  return boundary === -1 ? id.slice(0, MIN) : id.slice(0, boundary);
};

/** Trim a long agent spec to something a header can carry. */
const AGENT_HEADER_MAX = 48;

const agentToken = (agent: string | undefined): string | undefined => {
  if (!agent) return undefined;
  // pi-subagents uses `parallel:worker+worker` to mean several children; the
  // family prefix is redundant next to our own `subagent:` token.
  const bare = (agent.includes(":") ? agent.slice(agent.indexOf(":") + 1) : agent).trim();
  if (!bare) return undefined;
  return bare.length > AGENT_HEADER_MAX ? `${bare.slice(0, AGENT_HEADER_MAX - 1)}…` : bare;
};

/**
 * pi-subagents / pi-tau job ids are `<kind>-<pid>-<seq>` (`tmux-612613-98`,
 * `job-505106-122`). Used only when `details` carries no jobId, so the label
 * names something instead of degrading to `unknown`.
 */
const JOB_ID_RE = /\b((?:job|tmux)-\d+-\d+)\b/;
const jobIdFromText = (text: string | undefined): string | undefined =>
  text ? text.match(JOB_ID_RE)?.[1] : undefined;

const jobIdOf = (details: Record<string, unknown> | undefined, text: string | undefined): string | undefined =>
  asString(details?.jobId) ?? jobIdFromText(text);

// ── per-customType derivation ──────────────────────────────────────

const labelSupervisorRequest = (details: Record<string, unknown> | undefined): CustomLabel => {
  const agent = agentToken(asString(details?.agent)) ?? "child";
  const expectsReply = details?.expectsReply === true;
  const requestId = asString(details?.requestId) ?? asString(details?.id);
  return {
    header: `subagent:${agent}`,
    // A progress update carries no open question; only a pending ask can be
    // answered, so only a pending ask earns a route line. 12,175 of 22,556
    // corpus requests are progress updates.
    ...(expectsReply && requestId
      ? { route: `reply owed → ${SUPERVISOR_TOOL}({ action: "reply", replyTo: "${requestId}", message: "..." })` }
      : {}),
  };
};

const notifyCompletions = (details: Record<string, unknown> | undefined): Record<string, unknown>[] => {
  const completions = asArray(details?.completions).map(asRecord).filter((c): c is Record<string, unknown> => !!c);
  if (completions.length > 0) return completions;
  // A single completion persisted without the envelope.
  if (asString(details?.agent) && asString(details?.status)) return [details!];
  return [];
};

/**
 * pi-subagents' own first-line template, from `parseSubagentNotifyContent` in
 * `runs/background/notify.ts`. 28,611 of 72,002 corpus notifications carry no
 * `details` at all and reach the brief as text only, so the agent name has to
 * come from the template the producer itself wrote.
 */
const NOTIFY_LINE_RE = /^(Background task|Detached foreground task) (completed|failed|paused): \*\*(.+?)\*\*/;
const NOTIFY_GROUP_RE = /^Background tasks completed \((\d+)\): (.*)$/;

const labelNotify = (details: Record<string, unknown> | undefined, text: string | undefined): CustomLabel => {
  const completions = notifyCompletions(details);
  let agents = completions.map((c) => agentToken(asString(c.agent))).filter((a): a is string => !!a);
  let statuses = [...new Set(completions.map((c) => asString(c.status)).filter((s): s is string => !!s))];

  if (agents.length === 0 && text) {
    const first = text.split("\n")[0] ?? "";
    const single = NOTIFY_LINE_RE.exec(first);
    if (single) {
      agents = [agentToken(single[3]) ?? "child"];
      statuses = [single[2]!];
    } else {
      const group = NOTIFY_GROUP_RE.exec(first);
      if (group) {
        agents = group[2]!
          .split(",")
          // The header appends an optional taskInfo span, e.g. `**alpha** (1/2)`.
          .map((a) => agentToken(a.replace(/\*/g, "").replace(/\s*\([^)]*\)\s*$/, "").trim()))
          .filter((a): a is string => !!a);
        statuses = ["completed"];
      }
    }
  }

  const unique = [...new Set(agents)];
  // Terminal notification: there is nothing to reply to.
  return {
    header: `subagent:${unique.join("+") || "child"}`,
    ...(statuses.length === 1 ? { status: statuses[0] } : {}),
  };
};

const labelControlNotice = (details: Record<string, unknown> | undefined): CustomLabel => {
  const event = asRecord(details?.event);
  const agent = agentToken(asString(event?.agent)) ?? "child";
  const reason = asString(event?.reason);
  return {
    header: `subagent:${agent}`,
    ...(reason ? { status: reason } : {}),
  };
};

const labelIntercomMessage = (details: Record<string, unknown> | undefined): CustomLabel => {
  const from = asRecord(details?.from);
  const id = asString(from?.id);
  const name = asString(from?.name);
  // Header uses the id prefix because that is the arm pi-intercom expands.
  const source = id ? shortSessionId(id) : name ? shortSessionId(name) : "peer";
  const message = asRecord(details?.message);

  // pi-intercom attaches its own reply command to an ask that expects an
  // answer; prefer it verbatim over reconstructing the call. Reply is
  // `action:"reply", replyTo:<message.id>`, NOT `to:<peer>` — `to` addresses a
  // send, and without a `message` pi-intercom's inferAction falls through to
  // `list`, so a `to`-only call would do nothing.
  // `reply owed` needs positive evidence, not just an addressable peer: a
  // cross-machine notice can carry a replyCommand while owing no reply, and the
  // label would then promise an answer nobody is waiting for.
  const expectsReply = message?.expectsReply === true;
  const replyCommand = asString(details?.replyCommand);
  const messageId = asString(message?.id);
  const route = !expectsReply
    ? undefined
    : replyCommand
      ? `reply owed → ${replyCommand}`
      : messageId
        ? `reply owed → intercom({ action: "reply", replyTo: "${messageId}", message: "..." })`
        : undefined;

  return { header: `intercom:${source}`, ...(route ? { route } : {}) };
};

const labelJob = (details: Record<string, unknown> | undefined, text: string | undefined): CustomLabel => {
  const batch = asArray(details?.batch).map(asRecord).filter((b): b is Record<string, unknown> => !!b);
  if (batch.length > 0) {
    // pi-tau batches concurrent completions into one message with no
    // top-level jobId. Name the ids and aggregate the statuses.
    const ids = batch.map((b) => asString(b.jobId)).filter((id): id is string => !!id);
    const shown = [...new Set(ids)].slice(0, 2).join("+");
    const more = ids.length > 2 ? `+${ids.length - 2}` : "";
    const statuses = batch.map((b) => asString(b.status)).filter((s): s is string => !!s);
    const counts = new Map<string, number>();
    for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
    const summary = [...counts.entries()].map(([s, n]) => (n > 1 ? `${n} ${s}` : s)).join(", ");
    return {
      header: `job:${shown || "batch"}${more}`,
      ...(summary ? { status: summary } : {}),
    };
  }

  const jobId = jobIdOf(details, text);
  const status = asString(details?.status);
  return {
    header: `job:${jobId ?? "unknown"}`,
    ...(status ? { status } : {}),
  };
};

/**
 * customType → label. Anything not listed here still gets a non-user label:
 * the failure mode this replaces was an unrecognised customType rendering as
 * `[user]`, so the fallback must never be the human's name either.
 */
const DERIVERS: Record<string, (details: Record<string, unknown> | undefined, text: string | undefined) => CustomLabel> = {
  subagent_supervisor_request: (d) => labelSupervisorRequest(d),
  "subagent-notify": labelNotify,
  subagent_control_notice: (d) => labelControlNotice(d),
  intercom_message: (d) => labelIntercomMessage(d),
  "job-completion": labelJob,
  "bg-timeout": labelJob,
  "bg-stall": labelJob,
  "bg-trigger": labelJob,
  "bg-unavailable": labelJob,
  "tau-pending-decision": labelJob,
  auto_diag: () => ({ header: "auto-diag" }),
  "pi-branch-summary": () => ({ header: "summary:branch" }),
  "pi-compaction-summary": () => ({ header: "summary:previous" }),
};

/**
 * Header and optional route for a custom message.
 *
 * `text` is the message body, used only where a producer attaches no structured
 * fields and its own output template is the authority (notify, job ids).
 */
export const describeCustom = (customType: string, details: unknown, text?: string): CustomLabel => {
  const record = asRecord(details);
  const derive = DERIVERS[customType];
  if (derive) return derive(record, text);
  // Unknown producer: name it, do not attribute it to the user.
  return { header: `notification:${customType || "unknown"}` };
};

/** Render the bracket token that appears in the brief. */
export const labelToken = (label: CustomLabel): string =>
  label.status ? `[${label.header} · ${label.status}]` : `[${label.header}]`;