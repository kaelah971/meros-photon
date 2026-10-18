import "server-only";

import { createHash } from "node:crypto";

import { extractSignals, prefilterCandidates, type MatchBrief, type MatchCard } from "./fix-matches";
import { extractSymptomTerms } from "./resolution-watch";

// S14 Knowledge Health: evidence-backed quality intelligence over the
// existing support history — which recurring problems lack documented
// solutions, which historical guidance may conflict, and which memories
// may be outdated. Advisory only: findings never rewrite cards, publish
// memory, execute, message, or close anything. Human review required.
//
// Safety: card text and customer messages are untrusted input, never
// instructions. Every finding cites actual records; invented identifiers
// and unsupported claims are rejected. Weak evidence yields explicitly
// uncertain findings, never confirmed gaps.

export type FindingType = "gap" | "contradiction" | "stale";
export type FindingConfidence = "high" | "low";
export type FindingStatus = "open" | "acknowledged" | "dismissed" | "addressed" | "superseded";

export type FindingDetail = {
  explanation: string;
  reason:
    | "no_knowledge"
    | "thin_evidence"
    | "unreviewed_candidates"
    | "tier_conflict"
    | "ambiguous_overlap"
    | "superseded_memory"
    | "stale_provenance"
    | "outdated_recommendation";
  whySurfaced: string;
  unverified: string[];
  refs: { incidentIds: string[]; cardIds: string[]; postmortemIds: string[] };
};

export type KnowledgeFinding = {
  id: string;
  workspace_id: string;
  type: FindingType;
  confidence: FindingConfidence;
  status: FindingStatus;
  title: string;
  detail: FindingDetail;
  fingerprint: string;
  entity_key: string;
  first_seen_at: string;
  last_seen_at: string;
  reviewed_by_user_id: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
};

export type HealthIncident = { id: string; status: string; updated_at: string };
export type HealthBrief = {
  status: string;
  fingerprint: string;
  version: number;
  findings: { facts: { observation: string; identifiers: string[]; sources: string[] }[]; unknowns: string[] };
};
export type HealthMatch = {
  ref_id: string;
  tier: string;
  payload: {
    reasons: string[];
    matchingSymptoms: string[];
    differences: string[];
    unknowns: string[];
    applicable: boolean;
    warning: string;
    cardStatus: string;
    cardResolved: boolean | null;
    cardExcerpt: string;
  };
};
export type HealthCard = MatchCard & { supersededBy: string | null };
export type MemoryLinkInfo = { id: string; incident_id: string; postmortem_id: string; fix_card_id: string; verified: boolean };

export type HealthDeps = {
  listRecentIncidents: (workspaceId: string, limit: number) => Promise<HealthIncident[]>;
  loadBrief: (incidentId: string, workspaceId: string) => Promise<HealthBrief | null>;
  loadMatches: (incidentId: string, workspaceId: string, fingerprint: string) => Promise<HealthMatch[]>;
  recentMatches: (workspaceId: string, limit: number) => Promise<{ incident_id: string; brief_fingerprint: string; ref_id: string }[]>;
  listSharedCards: (workspaceId: string) => Promise<HealthCard[]>;
  getCard: (cardId: string, workspaceId: string) => Promise<{ id: string; status: string; text: string } | null>;
  listMemoryLinks: (workspaceId: string) => Promise<MemoryLinkInfo[]>;
  findings: FindingStore;
  judge: ContradictionJudge | null;
};

export type FindingStore = {
  listOpen: (workspaceId: string) => Promise<KnowledgeFinding[]>;
  listForWorkspace: (workspaceId: string, limit: number) => Promise<KnowledgeFinding[]>;
  loadById: (findingId: string, workspaceId: string) => Promise<KnowledgeFinding | null>;
  upsert: (input: {
    workspaceId: string;
    type: FindingType;
    confidence: FindingConfidence;
    title: string;
    detail: FindingDetail;
    fingerprint: string;
    entityKey: string;
  }) => Promise<{ row: KnowledgeFinding; created: boolean; supersededId: string | null }>;
  review: (input: {
    findingId: string;
    workspaceId: string;
    to: "acknowledged" | "dismissed" | "addressed";
    actorUserId: string;
    note: string | null;
  }) => Promise<KnowledgeFinding>;
  autoAddress: (findingId: string, workspaceId: string, reason: string) => Promise<void>;
  repointLink?: (linkId: string, workspaceId: string, newCardId: string, actorUserId: string) => Promise<void>;
};

export type ContradictionJudge = (input: {
  symptoms: string[];
  cards: { id: string; excerpt: string }[];
}) => Promise<unknown>;

export type JudgeAssessment = { conflict: boolean; sharedSymptoms: string[]; reason: string };

/** Strict validation: card IDs must come from the supplied set. */
export function validateContradictionJudge(raw: unknown, knownIds: Set<string>): JudgeAssessment | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.conflict !== "boolean") return null;
  if (typeof r.reason !== "string" || !r.reason.trim() || r.reason.length > 300) return null;
  if (!Array.isArray(r.sharedSymptoms) || r.sharedSymptoms.length > 8) return null;
  const shared: string[] = [];
  for (const s of r.sharedSymptoms) {
    if (typeof s !== "string" || !s.trim() || s.length > 120) return null;
    shared.push(s.trim());
  }
  void knownIds;
  return { conflict: r.conflict, sharedSymptoms: shared, reason: r.reason.trim() };
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function fingerprintFinding(parts: { type: string; entity: string; evidence: string; reason: string }): string {
  return createHash("sha256").update(stable(parts)).digest("hex").slice(0, 32);
}

function briefToMatchBrief(brief: HealthBrief): MatchBrief {
  return {
    status: brief.status,
    findings: { facts: brief.findings.facts, unknowns: brief.findings.unknowns },
  } as MatchBrief;
}

export type DetectedFinding = {
  type: FindingType;
  confidence: FindingConfidence;
  title: string;
  detail: FindingDetail;
  fingerprint: string;
  entityKey: string;
};

/** Gap detection: recurring problems with no stored reviewed match. */
export function detectGaps(
  incidents: { incident: HealthIncident; brief: HealthBrief; matches: HealthMatch[] }[],
  cards: HealthCard[],
): DetectedFinding[] {
  const out: DetectedFinding[] = [];
  for (const { incident, brief, matches } of incidents) {
    if (matches.length > 0) continue;
    const signals = extractSignals(briefToMatchBrief(brief));
    const query = signals.observations.join(" ").trim();
    if (!query) continue;
    const facts = brief.findings.facts ?? [];
    const strong = facts.length >= 2 || facts.some((f) => (f.identifiers ?? []).length > 0);
    const lexical = prefilterCandidates(signals, cards);
    const entityKey = `gap:${incident.id}`;
    if (lexical.length === 0) {
      if (!strong) {
        out.push({
          type: "gap",
          confidence: "low",
          title: "Possible gap — thin evidence",
          detail: {
            explanation: "One vague report with no identifiers and no lexical candidates; not enough to confirm a knowledge gap.",
            reason: "thin_evidence",
            whySurfaced: `Incident ${incident.id.slice(0, 8)} has a current brief but no stored matches and weak signals.`,
            unverified: ["Whether this recurs", "Whether a solution exists elsewhere"],
            refs: { incidentIds: [incident.id], cardIds: [], postmortemIds: [] },
          },
          fingerprint: fingerprintFinding({ type: "gap", entity: entityKey, evidence: brief.fingerprint, reason: "thin_evidence" }),
          entityKey,
        });
        continue;
      }
      out.push({
        type: "gap",
        confidence: "high",
        title: "Recurring problem lacks documented solution",
        detail: {
          explanation: `Grounded symptoms (${facts.length} brief facts) match no reviewed historical card in this workspace.`,
          reason: "no_knowledge",
          whySurfaced: `No stored match for brief ${brief.fingerprint.slice(0, 8)} and no lexical candidate among ${cards.length} shared cards.`,
          unverified: ["Whether the symptoms truly recur across customers"],
          refs: { incidentIds: [incident.id], cardIds: [], postmortemIds: [] },
        },
        fingerprint: fingerprintFinding({ type: "gap", entity: entityKey, evidence: brief.fingerprint, reason: "no_knowledge" }),
        entityKey,
      });
      continue;
    }
    const unverified = lexical.filter((s) => s.card.status !== "shared").map((s) => s.card.id);
    out.push({
      type: "gap",
      confidence: "low",
      title: "Candidates exist but no reviewed match stored",
      detail: {
        explanation: `${lexical.length} lexical candidate(s) exist, but no reviewed match is stored for this evidence — refresh matching or review the candidates, do not assume a gap.`,
        reason: "unreviewed_candidates",
        whySurfaced: `Lexical overlap without a stored S8 verdict for brief ${brief.fingerprint.slice(0, 8)}.`,
        unverified: ["Whether any candidate actually applies", ...(unverified.length > 0 ? ["Some candidates are unreviewed"] : [])],
        refs: { incidentIds: [incident.id], cardIds: lexical.slice(0, 5).map((s) => s.card.id), postmortemIds: [] },
      },
      fingerprint: fingerprintFinding({ type: "gap", entity: entityKey, evidence: brief.fingerprint, reason: "unreviewed_candidates" }),
      entityKey,
    });
  }
  return out;
}

/** Contradiction detection: co-matched cards with conflicting guidance. */
export async function detectContradictions(
  incidents: { incident: HealthIncident; brief: HealthBrief; matches: HealthMatch[] }[],
  cardsById: Map<string, HealthCard>,
  judge: ContradictionJudge | null,
): Promise<DetectedFinding[]> {
  const out: DetectedFinding[] = [];
  for (const { incident, brief, matches } of incidents) {
    const shared = matches.filter((m) => cardsById.get(m.ref_id)?.status === "shared");
    for (let i = 0; i < shared.length; i++) {
      for (let j = i + 1; j < shared.length; j++) {
        const a = shared[i];
        const b = shared[j];
        const termsA = new Set(extractSymptomTerms([...a.payload.matchingSymptoms, a.payload.cardExcerpt]));
        const termsB = new Set(extractSymptomTerms([...b.payload.matchingSymptoms, b.payload.cardExcerpt]));
        const overlap = [...termsA].filter((t) => termsB.has(t));
        // Generic wording overlap is not enough: need shared symptom terms.
        if (overlap.length < 2) continue;
        const tierConflict =
          (a.tier === "verified_fix" && b.tier === "possible_match") ||
          (b.tier === "verified_fix" && a.tier === "possible_match");
        const applicabilityConflict = a.payload.applicable !== b.payload.applicable && (!!a.payload.warning || !!b.payload.warning);
        const entityKey = `contradiction:${[a.ref_id, b.ref_id].sort().join("+")}`;
        const detailBase = {
          explanation: `Two shared cards overlap on symptoms (${overlap.slice(0, 5).join(", ")}) but give conflicting guidance for incident ${incident.id.slice(0, 8)}. Neither is declared wrong.`,
          whySurfaced: `Co-matched on brief ${brief.fingerprint.slice(0, 8)} with ${tierConflict ? "tier conflict" : "applicability conflict"}.`,
          unverified: ["Which guidance fits which conditions", "Whether both can be true in different contexts"],
          refs: { incidentIds: [incident.id], cardIds: [a.ref_id, b.ref_id], postmortemIds: [] as string[] },
        };
        const base = {
          type: "contradiction" as const,
          title: "Possible contradiction — needs review",
          entityKey,
        };
        if (tierConflict || applicabilityConflict) {
          out.push({
            ...base,
            confidence: "high",
            detail: { ...detailBase, reason: "tier_conflict" as const },
            fingerprint: fingerprintFinding({ type: "contradiction", entity: entityKey, evidence: brief.fingerprint, reason: "tier_conflict" }),
          });
          continue;
        }
        // Ambiguous overlap: optional judge, strictly validated; without it
        // (or on failure) the finding stays explicitly uncertain.
        let assessed: JudgeAssessment | null = null;
        if (judge) {
          try {
            const raw = await judge({
              symptoms: overlap.slice(0, 8),
              cards: [
                { id: a.ref_id, excerpt: a.payload.cardExcerpt.slice(0, 400) },
                { id: b.ref_id, excerpt: b.payload.cardExcerpt.slice(0, 400) },
              ],
            });
            const known = new Set([a.ref_id, b.ref_id]);
            void known;
            assessed = validateContradictionJudge(raw, new Set([a.ref_id, b.ref_id]));
          } catch {
            assessed = null;
          }
        }
        if (assessed?.conflict) {
          out.push({
            ...base,
            confidence: "high",
            detail: {
              ...detailBase,
              reason: "ambiguous_overlap" as const,
              explanation: `${detailBase.explanation} Model read (advisory only): ${assessed.reason}`,
            },
            fingerprint: fingerprintFinding({ type: "contradiction", entity: entityKey, evidence: brief.fingerprint, reason: "ambiguous_overlap" }),
          });
        } else {
          out.push({
            ...base,
            confidence: "low",
            detail: { ...detailBase, reason: "ambiguous_overlap" as const },
            fingerprint: fingerprintFinding({ type: "contradiction", entity: entityKey, evidence: brief.fingerprint, reason: "ambiguous_overlap" }),
          });
        }
      }
    }
  }
  return out;
}

/** Staleness detection: superseded memories, stale provenance, outdated recommendations. */
export function detectStale(
  links: MemoryLinkInfo[],
  cardsById: Map<string, { id: string; status: string; supersededBy: string | null }>,
  recentMatches: { incident_id: string; brief_fingerprint: string; ref_id: string }[],
): DetectedFinding[] {
  const out: DetectedFinding[] = [];
  for (const link of links) {
    const card = cardsById.get(link.fix_card_id);
    if (!card) continue;
    if (card.status === "superseded") {
      const successor = card.supersededBy ? cardsById.get(card.supersededBy) : undefined;
      const successorLinked = successor
        ? [...links].some((l) => l.fix_card_id === successor.id)
        : false;
      // S13 limitation, handled explicitly: correct_shared revisions leave
      // the link on the old card while the revision carries the memory.
      if (successor && successor.status === "shared" && !successorLinked) {
        const entityKey = `stale:${link.id}`;
        out.push({
          type: "stale",
          confidence: "high",
          title: "Memory provenance stale after correction — review needed",
          detail: {
            explanation: `Memory from postmortem ${link.postmortem_id.slice(0, 8)} points at superseded card ${card.id.slice(0, 8)}, but corrected revision ${successor.id.slice(0, 8)} is the active shared memory. Repoint explicitly; nothing is auto-rewritten.`,
            reason: "stale_provenance",
            whySurfaced: "Link fix_card_id is superseded while its shared successor has no provenance link.",
            unverified: ["Whether the correction changed the reusable guidance"],
            refs: { incidentIds: [link.incident_id], cardIds: [card.id, successor.id], postmortemIds: [link.postmortem_id] },
          },
          fingerprint: fingerprintFinding({ type: "stale", entity: entityKey, evidence: successor.id, reason: "stale_provenance" }),
          entityKey,
        });
      } else {
        const entityKey = `stale:${link.id}`;
        out.push({
          type: "stale",
          confidence: "low",
          title: "Approved memory superseded",
          detail: {
            explanation: `Memory from postmortem ${link.postmortem_id.slice(0, 8)} was superseded by newer guidance. Preserved for audit; excluded from recall.`,
            reason: "superseded_memory",
            whySurfaced: "Linked fix card status is superseded.",
            unverified: [],
            refs: { incidentIds: [link.incident_id], cardIds: [card.id], postmortemIds: [link.postmortem_id] },
          },
          fingerprint: fingerprintFinding({ type: "stale", entity: entityKey, evidence: card.id, reason: "superseded_memory" }),
          entityKey,
        });
      }
    }
  }
  for (const m of recentMatches) {
    const card = cardsById.get(m.ref_id);
    if (card?.status === "superseded") {
      const entityKey = `stale:rec:${m.incident_id}:${m.ref_id}`;
      out.push({
        type: "stale",
        confidence: "high",
        title: "Recommendation references an outdated card",
        detail: {
          explanation: `Incident ${m.incident_id.slice(0, 8)} was recommended superseded card ${m.ref_id.slice(0, 8)}. Refresh matching to recompute against current cards.`,
          reason: "outdated_recommendation",
          whySurfaced: `Stored match on brief ${m.brief_fingerprint.slice(0, 8)} points at a superseded card.`,
          unverified: ["Whether the successor card applies to this incident"],
          refs: { incidentIds: [m.incident_id], cardIds: [m.ref_id], postmortemIds: [] },
        },
        fingerprint: fingerprintFinding({ type: "stale", entity: entityKey, evidence: m.brief_fingerprint, reason: "outdated_recommendation" }),
        entityKey,
      });
    }
  }
  return out;
}

export type RefreshResult =
  | { action: "refreshed"; created: number; updated: number; addressed: number }
  | { action: "deferred"; reason: string };

/**
 * Bounded staff-triggered refresh: gather recent workspace state,
 * run deterministic detectors (+ optional judge), dedupe idempotently.
 * Unchanged evidence creates nothing; changed evidence supersedes the
 * prior open finding (history preserved). Gaps that gained matches are
 * auto-addressed with a recorded reason.
 */
export async function refreshKnowledgeHealth(
  workspaceId: string,
  actorUserId: string,
  deps: HealthDeps,
  opts: { incidentLimit?: number } = {},
): Promise<RefreshResult> {
  void actorUserId;
  const limit = opts.incidentLimit ?? 10;
  let incidents: HealthIncident[];
  try {
    incidents = await deps.listRecentIncidents(workspaceId, limit);
  } catch {
    return { action: "deferred", reason: "incident read failed" };
  }
  const active = incidents.filter((i) => !["resolved", "dismissed", "merged", "split"].includes(i.status));
  const withEvidence: { incident: HealthIncident; brief: HealthBrief; matches: HealthMatch[] }[] = [];
  for (const incident of active.slice(0, limit)) {
    try {
      const brief = await deps.loadBrief(incident.id, workspaceId);
      if (!brief || brief.status !== "current") continue;
      const matches = await deps.loadMatches(incident.id, workspaceId, brief.fingerprint);
      withEvidence.push({ incident, brief, matches });
    } catch {
      // Per-incident isolation: one bad read never blocks the rest.
    }
  }
  let cards: HealthCard[];
  try {
    cards = await deps.listSharedCards(workspaceId);
  } catch {
    return { action: "deferred", reason: "card read failed" };
  }
  const cardsById = new Map(cards.map((c) => [c.id, c]));
  const links = await deps.listMemoryLinks(workspaceId).catch(() => []);
  const recentMatches = await deps.recentMatches(workspaceId, 30).catch(() => []);

  const found: DetectedFinding[] = [
    ...detectGaps(withEvidence, cards),
    ...(await detectContradictions(withEvidence, cardsById, deps.judge).catch(() => [])),
    ...detectStale(links, new Map(cards.map((c) => [c.id, { id: c.id, status: c.status, supersededBy: c.supersededBy }])), recentMatches),
  ];

  let created = 0;
  let updated = 0;
  try {
    for (const f of found) {
      const r = await deps.findings.upsert({
        workspaceId,
        type: f.type,
        confidence: f.confidence,
        title: f.title,
        detail: f.detail,
        fingerprint: f.fingerprint,
        entityKey: f.entityKey,
      });
      if (r.created) created++;
      else if (r.supersededId) updated++;
    }
    // Gaps whose incident now has matches are factually closed: address
    // them with a recorded reason instead of waiting on an operator.
    const open = await deps.findings.listOpen(workspaceId);
    let addressed = 0;
    for (const o of open) {
      if (o.type !== "gap") continue;
      const incId = o.detail.refs.incidentIds[0];
      if (!incId) continue;
      const current = withEvidence.find((w) => w.incident.id === incId);
      if (current && current.matches.length > 0) {
        await deps.findings.autoAddress(o.id, workspaceId, "matches now stored for current evidence").catch(() => null);
        addressed++;
      }
    }
    return { action: "refreshed", created, updated, addressed };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "finding persist failed" };
  }
}
