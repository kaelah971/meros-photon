import "server-only";

// Privacy-safe structured Radar decision log.
// Single source for the outcome categories required for diagnosis:
//   detection_skipped | detection_created | detection_joined |
//   radar_ineligible | no_eligible_operator |
//   notification_suppressed | notification_attempted |
//   notification_failed | notification_accepted
//
// Privacy contract (enforced by tests):
// - NEVER logs message contents, phone numbers, session tokens,
//   credentials, private memories, raw conversation addresses
//   (thread ids), customer ids, operator user ids, or full UUIDs.
// - ONLY logs: outcome category, workspace slug (public route segment),
//   candidate id prefix (first 8 chars), counts, booleans, and a
//   sanitized short reason (fixed gateway strings, truncated, single-line).
// - Provider acceptance is reported as accepted, never claimed delivery.

export type RadarDecisionOutcome =
  | "detection_skipped"
  | "detection_created"
  | "detection_joined"
  | "radar_ineligible"
  | "no_eligible_operator"
  | "notification_suppressed"
  | "notification_attempted"
  | "notification_failed"
  | "notification_accepted";

export type RadarDecisionFields = {
  outcome: RadarDecisionOutcome;
  workspaceSlug: string;
  candidateIdPrefix: string;
  newConversation?: boolean;
  customers?: number;
  conversations?: number;
  sent?: number;
  deduped?: number;
  suppressed?: number;
  reason?: string;
};

const MAX_REASON_CHARS = 120;

export function safeIdPrefix(id: string | null | undefined): string {
  const clean = (id ?? "").trim();
  if (!clean || clean.toLowerCase() === "none") return "none";
  return clean.slice(0, 8);
}

export function safeSlug(slug: string | null | undefined): string {
  const clean = (slug ?? "").trim().slice(0, 80);
  if (!clean) return "unknown";
  // Slugs are lowercase alphanumerics + dashes; strip anything else.
  return clean.replace(/[^a-zA-Z0-9-_]/g, "") || "unknown";
}

export function sanitizeReason(reason: string | null | undefined): string | undefined {
  if (reason == null) return undefined;
  const clean = String(reason).replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
  return clean || undefined;
}

export function formatRadarDecision(fields: RadarDecisionFields): Record<string, unknown> {
  const out: Record<string, unknown> = {
    src: "radar-decision",
    outcome: fields.outcome,
    workspace: safeSlug(fields.workspaceSlug),
    candidate: safeIdPrefix(fields.candidateIdPrefix),
  };
  if (typeof fields.newConversation === "boolean") out.newConversation = fields.newConversation;
  if (typeof fields.customers === "number") out.customers = fields.customers;
  if (typeof fields.conversations === "number") out.conversations = fields.conversations;
  if (typeof fields.sent === "number") out.sent = fields.sent;
  if (typeof fields.deduped === "number") out.deduped = fields.deduped;
  if (typeof fields.suppressed === "number") out.suppressed = fields.suppressed;
  const reason = sanitizeReason(fields.reason);
  if (reason) out.reason = reason;
  return out;
}

export function logRadarDecision(
  fields: RadarDecisionFields,
  sink: (line: string) => void = (line) => console.log(line),
): void {
  try {
    sink(`[radar-decision] ${JSON.stringify(formatRadarDecision(fields))}`);
  } catch {
    // Logging must never break the chat background chain.
  }
}

export type RadarActionForMapping =
  | { action: "ineligible"; reason: string }
  | { action: "no_recipients" }
  | { action: "deferred"; reason: string }
  | { action: "alerted"; sent: number; deduped: number; suppressed: number };

/**
 * Map a Radar engine result to the observable outcome category.
 * - ineligible -> radar_ineligible
 * - no_recipients -> no_eligible_operator
 * - deferred (transient read failure) -> notification_failed (retryable, diagnosable)
 * - alerted sent>0 -> notification_accepted (provider accepted; NOT handset delivery)
 * - alerted deduped>0 (and sent==0) -> notification_attempted (already attempted key)
 * - alerted suppressed>0 (and sent==0, deduped==0) -> notification_suppressed
 */
export function mapRadarResultToOutcome(result: RadarActionForMapping): RadarDecisionOutcome {
  if (result.action === "ineligible") return "radar_ineligible";
  if (result.action === "no_recipients") return "no_eligible_operator";
  if (result.action === "deferred") return "notification_failed";
  if (result.sent > 0) return "notification_accepted";
  if (result.deduped > 0) return "notification_attempted";
  return "notification_suppressed";
}
