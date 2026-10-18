import "server-only";

import { checkRedaction } from "./support-memory";

// S15B Automatic Incident Radar: after S5 clusters a qualifying candidate,
// proactively iMessage ONLY explicitly opted-in operators. This is a
// POSSIBLE INCIDENT alert, never a confirmed incident or recovery action.
//
// Rules enforced here (not trusted to callers):
// - Default OFF: missing/false/unreadable opt-in sends nothing.
// - Threshold: ≥3 distinct customers AND ≥3 distinct conversations with
//   qualifying reports inside a 60-minute window, candidate still pending,
//   meaningful non-generic evidence. Evaluated from PERSISTED memberships,
//   never Gemini estimates, and only on genuine new membership.
// - One alert per (candidate, operator): idempotency keys are per-operator,
//   so one operator's key never suppresses another's.
// - Quiet-hours/disabled suppression claims no slot and records no send.
// - Provider acceptance is not handset delivery; failures are recorded,
//   never retried with a fresh key.

export const RADAR_MIN_CUSTOMERS = 3;
export const RADAR_MIN_CONVERSATIONS = 3;
export const RADAR_WINDOW_MINUTES = 60;
export const RADAR_FALLBACK_TITLE = "Possible recurring support issue";

const GENERIC_WORDS = new Set(
  "payment,failed,fails,failing,error,errors,please,thanks,thank,issue,issues,problem,problems,account,help,need,urgent,asap,hello,hi,hey,support,customer,service,order,money,transfer,refund,charge,card,visa,pay,payment".split(","),
);

export function significantTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((w) => !GENERIC_WORDS.has(w));
}

/**
 * Candidate titles are model-generated and untrusted: use verbatim only
 * when short, single-line, PII-free, and specific (≥2 significant tokens).
 * Otherwise fall back to a generic title rather than leak anything.
 */
export function safeRadarTitle(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 140) return RADAR_FALLBACK_TITLE;
  if (checkRedaction(clean).passed === false) return RADAR_FALLBACK_TITLE;
  if (significantTokens(clean).length < 2) return RADAR_FALLBACK_TITLE;
  return clean;
}

export type RadarMember = { conversation_id: string; customer_id: string; added_at: string };
export type RadarCandidate = {
  id: string;
  status: string;
  title: string;
  summary: string;
  updated_at: string;
};

export type RadarEligibility =
  | {
      eligible: true;
      customers: number;
      conversations: number;
      windowMinutes: number;
      windowStart: string;
      title: string;
    }
  | { eligible: false; reason: string };

/**
 * Pure threshold evaluation over persisted memberships. Sliding 60-minute
 * window: some subset of memberships must contain ≥3 distinct customers
 * AND ≥3 distinct conversations. `now` is injectable for tests.
 */
export function evaluateRadarEligibility(
  candidate: RadarCandidate,
  members: RadarMember[],
  messageCount: number,
  now: Date = new Date(),
): RadarEligibility {
  if (candidate.status !== "pending") {
    return { eligible: false, reason: `candidate is ${candidate.status}, not pending review` };
  }
  if (!candidate.title.trim() && !candidate.summary.trim()) {
    return { eligible: false, reason: "candidate has no meaningful evidence" };
  }
  if (significantTokens(`${candidate.title} ${candidate.summary}`).length < 2) {
    return { eligible: false, reason: "candidate evidence is generic-only" };
  }
  if (messageCount < RADAR_MIN_CUSTOMERS) {
    return { eligible: false, reason: "insufficient qualifying reports" };
  }
  const times = members
    .map((m) => ({ m, t: Date.parse(m.added_at) }))
    .filter((x) => Number.isFinite(x.t) && x.t <= now.getTime())
    .sort((a, b) => a.t - b.t);
  const windowMs = RADAR_WINDOW_MINUTES * 60_000;
  let best: { customers: number; conversations: number; start: number } | null = null;
  for (let i = 0; i < times.length; i++) {
    const convos = new Set<string>();
    const custs = new Set<string>();
    for (let j = i; j < times.length && times[j].t - times[i].t <= windowMs; j++) {
      convos.add(times[j].m.conversation_id);
      custs.add(times[j].m.customer_id);
    }
    if (convos.size >= RADAR_MIN_CONVERSATIONS && custs.size >= RADAR_MIN_CUSTOMERS) {
      best = { customers: custs.size, conversations: convos.size, start: times[i].t };
      break;
    }
  }
  if (!best) {
    return { eligible: false, reason: "no 60-minute window with 3 customers and 3 conversations" };
  }
  return {
    eligible: true,
    customers: best.customers,
    conversations: best.conversations,
    windowMinutes: RADAR_WINDOW_MINUTES,
    windowStart: new Date(best.start).toISOString(),
    title: safeRadarTitle(candidate.title || candidate.summary),
  };
}

export function radarIdempotencyKey(candidateId: string, operatorUserId: string): string {
  return `radar:${candidateId}:${operatorUserId}`.slice(0, 128);
}

/**
 * Deterministic alert body. Names no customers, quotes no messages, leaks
 * no contact details — only the sanitized title, counts, window, and the
 * authenticated candidate-review link. Never implies confirmation.
 */
export function buildRadarMessage(input: {
  title: string;
  customers: number;
  conversations: number;
  windowMinutes: number;
  candidateId: string;
  workspaceSlug: string;
}): string {
  const lines = [
    "MEROS / INCIDENT RADAR",
    "",
    "Possible recurring issue",
    "",
    input.title,
    `${input.customers} distinct customers · ${input.conversations} conversations · last ${input.windowMinutes} min`,
    "",
    "Review required. No automatic incident, no action taken.",
    `/app/workspaces/${input.workspaceSlug}/incidents/detected/${input.candidateId}`,
  ];
  return lines.join("\n").slice(0, 2000);
}

export type RadarRecipient = { operatorUserId: string; bindingId: string; threadId: string };

export type RadarDeps = {
  loadCandidate: (candidateId: string, workspaceId: string) => Promise<RadarCandidate | null>;
  listMembers: (candidateId: string, workspaceId: string) => Promise<RadarMember[]>;
  countMessages: (candidateId: string, workspaceId: string) => Promise<number>;
  listOptedIn: (workspaceId: string) => Promise<string[]>;
  resolveRecipient: (workspaceId: string, operatorUserId: string) => Promise<RadarRecipient | null>;
  workspaceSlug: (workspaceId: string) => Promise<string | null>;
  notify: (input: {
    workspaceId: string;
    operatorUserId: string;
    bindingId: string;
    threadId: string;
    body: string;
    idempotencyKey: string;
  }) => Promise<{ sent: boolean; deduped: boolean; reason: string }>;
};

export type RadarResult =
  | { action: "alerted"; sent: number; deduped: number; suppressed: number }
  | { action: "ineligible"; reason: string }
  | { action: "no_recipients" }
  | { action: "deferred"; reason: string };

/**
 * Evaluate one candidate and alert every eligible opted-in operator.
 * Never throws: failures resolve to deferred/suppressed counts and the
 * chat background chain stays safe.
 */
export async function maybeSendRadarAlert(
  workspaceId: string,
  candidateId: string,
  deps: RadarDeps,
  now: Date = new Date(),
): Promise<RadarResult> {
  let candidate: RadarCandidate | null;
  try {
    candidate = await deps.loadCandidate(candidateId, workspaceId);
  } catch {
    return { action: "deferred", reason: "candidate read failed" };
  }
  if (!candidate) return { action: "deferred", reason: "candidate not found in this workspace" };
  let members: RadarMember[];
  let messageCount: number;
  try {
    [members, messageCount] = await Promise.all([
      deps.listMembers(candidateId, workspaceId),
      deps.countMessages(candidateId, workspaceId),
    ]);
  } catch {
    return { action: "deferred", reason: "membership read failed" };
  }
  const eligibility = evaluateRadarEligibility(candidate, members, messageCount, now);
  if (!eligibility.eligible) return { action: "ineligible", reason: eligibility.reason };
  let optedIn: string[];
  try {
    optedIn = await deps.listOptedIn(workspaceId);
  } catch {
    return { action: "deferred", reason: "opt-in read failed" };
  }
  if (optedIn.length === 0) return { action: "no_recipients" };
  const slug = await deps.workspaceSlug(workspaceId).catch(() => null);
  if (!slug) return { action: "deferred", reason: "workspace not found" };
  const body = buildRadarMessage({
    title: eligibility.title,
    customers: eligibility.customers,
    conversations: eligibility.conversations,
    windowMinutes: eligibility.windowMinutes,
    candidateId,
    workspaceSlug: slug,
  });
  let sent = 0;
  let deduped = 0;
  let suppressed = 0;
  for (const operatorUserId of optedIn) {
    try {
      const recipient = await deps.resolveRecipient(workspaceId, operatorUserId);
      if (!recipient) {
        suppressed++;
        continue;
      }
      const r = await deps.notify({
        workspaceId,
        operatorUserId,
        bindingId: recipient.bindingId,
        threadId: recipient.threadId,
        body,
        idempotencyKey: radarIdempotencyKey(candidateId, operatorUserId),
      });
      if (r.sent) sent++;
      else if (r.deduped) deduped++;
      else suppressed++;
    } catch {
      suppressed++;
    }
  }
  return { action: "alerted", sent, deduped, suppressed };
}

/** Production wiring: issue candidates + Photon bindings/prefs/notify. */
export async function realRadarDeps(): Promise<RadarDeps> {
  const { getCandidateForWorkspace, listCandidateMembers, listCandidateMessages } = await import("./issue-candidates");
  const { listRadarOptedIn } = await import("./photon/preferences");
  return {
    loadCandidate: async (candidateId, workspaceId) => {
      const c = await getCandidateForWorkspace(candidateId, workspaceId).catch(() => null);
      return c ? { id: c.id, status: c.status, title: c.title, summary: c.summary, updated_at: c.updated_at } : null;
    },
    listMembers: async (candidateId, workspaceId) => {
      const rows = await listCandidateMembers(candidateId, workspaceId).catch(() => []);
      return rows.map((r) => ({ conversation_id: r.conversation_id, customer_id: r.customer_id, added_at: r.added_at }));
    },
    countMessages: async (candidateId, workspaceId) => {
      const { listCandidateMessages } = await import("./issue-candidates");
      const rows = await listCandidateMessages(candidateId, workspaceId, 100).catch(() => []);
      return rows.length;
    },
    listOptedIn: (workspaceId) => listRadarOptedIn(workspaceId),
    resolveRecipient: async (workspaceId, operatorUserId) => {
      const { resolveActiveBindingForOperator } = await import("./photon/bindings");
      const { requireStaff } = await import("./support-ops");
      const { getPreferences, isStoredPreferencesMalformed } = await import("./photon/preferences");
      const b = await resolveActiveBindingForOperator(workspaceId, operatorUserId).catch(() => null);
      if (!b || !b.thread_id) return null;
      try {
        await requireStaff(operatorUserId, workspaceId);
      } catch {
        return null;
      }
      const prefs = await getPreferences(workspaceId, operatorUserId).catch(() => null);
      if (!prefs || prefs.proactiveEnabled === false) return null;
      if (await isStoredPreferencesMalformed(workspaceId, operatorUserId).catch(() => true)) return null;
      if (prefs.quietHoursEnabled) {
        const { isQuietNow } = await import("./photon/preferences");
        if (isQuietNow(prefs, new Date())) return null;
      }
      return { operatorUserId, bindingId: b.id, threadId: b.thread_id };
    },
    workspaceSlug: async (workspaceId) => {
      const { getWorkspaceById } = await import("./db");
      const ws = await getWorkspaceById(workspaceId).catch(() => null);
      return ws ? ws.slug : null;
    },
    notify: async (input) => {
      const { sendOperatorNotification } = await import("./photon/notify");
      const { claimProactiveSlot, markOutboundSent, markOutboundFailed } = await import("./photon/history");
      const { postToThread } = await import("./photon/bot");
      const { requireStaff: checkStaff } = await import("./support-ops");
      const { getPreferences, isStoredPreferencesMalformed } = await import("./photon/preferences");
      const { resolveActiveBindingForOperator } = await import("./photon/bindings");
      const result = await sendOperatorNotification(
        {
          workspaceId: input.workspaceId,
          operatorUserId: input.operatorUserId,
          type: "incident_detected",
          body: input.body,
          idempotencyKey: input.idempotencyKey,
          isTest: false,
        },
        {
          findBindingForOperator: async (workspaceId, operatorUserId) => {
            const b = await resolveActiveBindingForOperator(workspaceId, operatorUserId);
            return b ? { id: b.id, workspaceId: b.workspace_id, operatorUserId, threadId: b.thread_id } : null;
          },
          checkStaff: async (userId, workspaceId) => {
            await checkStaff(userId, workspaceId);
          },
          getPreferences: async (workspaceId, operatorUserId) => {
            const p = await getPreferences(workspaceId, operatorUserId);
            return {
              proactiveEnabled: p.proactiveEnabled,
              quietHoursEnabled: p.quietHoursEnabled,
              quietStart: p.quietStart,
              quietEnd: p.quietEnd,
              timezone: p.timezone,
              malformed: await isStoredPreferencesMalformed(workspaceId, operatorUserId),
            };
          },
          claimProactive: async (claim) => {
            const { row, deduped } = await claimProactiveSlot({
              workspaceId: input.workspaceId,
              bindingId: input.bindingId,
              threadId: claim.threadId,
              bodyText: claim.bodyText,
              idempotencyKey: claim.idempotencyKey,
            });
            return { id: row.id, status: row.status, providerMessageId: row.provider_message_id, deduped };
          },
          markSent: (id, pid) => markOutboundSent(id, pid),
          markFailed: (id) => markOutboundFailed(id),
          postToThread,
        },
      );
      if (result.ok) {
        if (result.deduped) return { sent: false, deduped: true, reason: "already attempted for this key" };
        return { sent: true, deduped: false, reason: "accepted by provider — handset delivery not confirmed" };
      }
      if (result.code === "already_attempted") {
        // A previous attempt claimed the key and failed; Radar never
        // retries with a fresh key, so this stays unsent and uncounted.
        return { sent: false, deduped: false, reason: result.message };
      }
      if (result.suppressed) return { sent: false, deduped: false, reason: result.message };
      // Provider failure, degraded DB, or missing conversation/thread:
      // recorded, never retried with a fresh key by Radar.
      return { sent: false, deduped: false, reason: result.message };
    },
  };
}
