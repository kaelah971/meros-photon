import "server-only";

import { formatSharedFix, validateSharedCandidate } from "./support-memory";

// S13 Operator Memory: turn evidence-backed incident outcomes into
// reusable, operator-controlled knowledge. Loop: closed incident →
// grounded candidate → explicit staff review (existing Fix Card flow) →
// approved shared memory → recall in later incidents (existing S8 path).
//
// A postmortem is historical evidence, not automatically a proven fix.
// Administrative closures never become verified recovery. Hypotheses are
// never rewritten as established causes. Nothing here executes, sends,
// closes incidents, or writes memory without explicit staff approval.

export type MemoryOutcomeLabel =
  | "CONFIRMED OUTCOME"
  | "DOCUMENTED ACTION"
  | "HYPOTHESIS"
  | "UNKNOWN"
  | "ADMINISTRATIVE CLOSURE";

export type MemoryTier = "verified_fix" | "documented_unverified";

export type MemoryProvenance = {
  incidentId: string;
  postmortemId: string;
  sourceFingerprint: string;
  briefFingerprint: string;
  watchStatus: string;
  closureMode: "verified" | "administrative";
};

export type MemoryCandidate = {
  tier: MemoryTier;
  symptom: string;
  cause: string;
  resolution: string;
  causeLabel: MemoryOutcomeLabel;
  outcomeLabel: MemoryOutcomeLabel;
  provenance: MemoryProvenance;
  text: string;
};

export type MemoryLinkRow = {
  id: string;
  incident_id: string;
  workspace_id: string;
  postmortem_id: string;
  fix_card_id: string;
  tier: MemoryTier;
  verified: boolean;
  source_fingerprint: string;
  created_by_user_id: string | null;
  created_at: string;
};

export type CandidateBuild =
  | { eligible: true; candidate: MemoryCandidate }
  | { eligible: false; reason: string };

export type ClosureMode = "verified" | "administrative" | "none";

type PostmortemInput = {
  id: string;
  incident_id: string;
  workspace_id: string;
  status: string;
  source_fingerprint: string;
  brief_fingerprint: string;
  content: {
    symptoms: string[];
    outcome: string;
    rootCause: { status: string; statement: string };
    interventions: { id: string; status: string; ref: string | null }[];
    watch: { status: string; observations: number; improvements: number; regressions: number; confirmedBy: string | null };
    unknowns: string[];
  };
};

/**
 * Pure candidate derivation from a finalized postmortem. Verified closures
 * with confirmed customer improvement yield candidates; administrative
 * closures and evidence-free postmortems are refused with explicit reasons.
 */
export function buildMemoryCandidate(
  postmortem: PostmortemInput,
  closureMode: ClosureMode,
): CandidateBuild {
  if (postmortem.status !== "finalized") {
    return { eligible: false, reason: "postmortem is not finalized" };
  }
  if (closureMode !== "verified") {
    return {
      eligible: false,
      reason:
        closureMode === "administrative"
          ? "administrative closure has no verified outcome and cannot become shared memory"
          : "no verified closure recorded for this incident",
    };
  }
  const w = postmortem.content.watch;
  if (w.status !== "resolution_confirmed" || w.improvements === 0) {
    return { eligible: false, reason: "no confirmed customer resolution to reuse" };
  }
  const interventions = postmortem.content.interventions.filter((i) =>
    ["verified_success", "verified_failure", "unknown_outcome"].includes(i.status),
  );
  if (interventions.length === 0) {
    return { eligible: false, reason: "no documented intervention to reuse" };
  }
  const symptom = postmortem.content.symptoms.slice(0, 3).join(" / ").slice(0, 400).trim();
  if (!symptom) return { eligible: false, reason: "no observable symptoms recorded" };

  const rc = postmortem.content.rootCause;
  let cause: string;
  let causeLabel: MemoryOutcomeLabel;
  if (rc.status === "verified") {
    cause = rc.statement.slice(0, 400);
    causeLabel = "CONFIRMED OUTCOME";
  } else if (rc.status === "unverified" && rc.statement.trim()) {
    cause = `(unverified hypothesis) ${rc.statement}`.slice(0, 400);
    causeLabel = "HYPOTHESIS";
  } else {
    cause = "(unknown — see postmortem; no verified root cause recorded)";
    causeLabel = "UNKNOWN";
  }

  const acted = interventions[0];
  const resolution = (
    `Documented manual action ${acted.id.slice(0, 8)} (${acted.status})` +
    (acted.ref ? `, external ref ${acted.ref.slice(0, 60)}` : "") +
    `. Customer-confirmed improvement followed; see incident postmortem.`
  ).slice(0, 400);

  const provenance: MemoryProvenance = {
    incidentId: postmortem.incident_id,
    postmortemId: postmortem.id,
    sourceFingerprint: postmortem.source_fingerprint,
    briefFingerprint: postmortem.brief_fingerprint,
    watchStatus: w.status,
    closureMode: "verified",
  };
  const text = formatSharedFix({ symptom, cause, resolution });
  return {
    eligible: true,
    candidate: {
      tier: "verified_fix",
      symptom,
      cause,
      resolution,
      causeLabel,
      outcomeLabel: "CONFIRMED OUTCOME",
      provenance,
      text,
    },
  };
}

export type MemoryStore = {
  findByPostmortem: (postmortemId: string, workspaceId: string) => Promise<MemoryLinkRow | null>;
  listApprovedForIncident: (incidentId: string, workspaceId: string) => Promise<MemoryLinkRow[]>;
  listForCards: (workspaceId: string, cardIds: string[]) => Promise<Map<string, MemoryLinkRow>>;
  insert: (input: {
    incidentId: string;
    workspaceId: string;
    postmortemId: string;
    fixCardId: string;
    tier: MemoryTier;
    verified: boolean;
    fingerprint: string;
    createdBy: string;
  }) => Promise<{ row: MemoryLinkRow; deduped: boolean }>;
};

export type MemoryDeps = {
  loadPostmortem: (postmortemId: string, workspaceId: string) => Promise<PostmortemInput | null>;
  closureMode: (incidentId: string, workspaceId: string) => Promise<ClosureMode>;
  linkTargets: (incidentId: string, workspaceId: string) => Promise<{ customerId: string | null; conversationId: string | null }>;
  createCard: (input: { workspaceId: string; customerId: string; conversationId: string; text: string }) => Promise<{ id: string }>;
  links: MemoryStore;
};

export type ProposeResult =
  | { action: "proposed"; link: MemoryLinkRow; cardId: string }
  | { action: "duplicate"; link: MemoryLinkRow; cardId: string }
  | { action: "deferred"; reason: string };

/**
 * Propose a memory candidate: eligibility → redaction/shape validation →
 * pending Fix Card + provenance link. Idempotent per postmortem. Never
 * publishes: sharing stays an explicit staff decision in Fix Card review.
 */
export async function proposeMemoryCandidate(
  incidentId: string,
  workspaceId: string,
  actorUserId: string,
  input: { postmortemId: string },
  deps: MemoryDeps,
): Promise<ProposeResult> {
  const existing = await deps.links.findByPostmortem(input.postmortemId, workspaceId).catch(() => null);
  if (existing) return { action: "duplicate", link: existing, cardId: existing.fix_card_id };
  const pm = await deps.loadPostmortem(input.postmortemId, workspaceId).catch(() => null);
  if (!pm || pm.incident_id !== incidentId) {
    return { action: "deferred", reason: "postmortem not found for this incident" };
  }
  const mode = await deps.closureMode(incidentId, workspaceId).catch(() => "none" as ClosureMode);
  const built = buildMemoryCandidate(pm, mode);
  if (!built.eligible) return { action: "deferred", reason: built.reason };
  const gate = validateSharedCandidate(built.candidate.text);
  if (!gate.ok) {
    return { action: "deferred", reason: `candidate failed review gate: ${gate.error}` };
  }
  const targets = await deps.linkTargets(incidentId, workspaceId).catch(() => ({ customerId: null, conversationId: null }));
  if (!targets.customerId || !targets.conversationId) {
    return { action: "deferred", reason: "no linked customer conversation to anchor the candidate" };
  }
  let cardId: string;
  try {
    const card = await deps.createCard({
      workspaceId,
      customerId: targets.customerId,
      conversationId: targets.conversationId,
      text: built.candidate.text,
    });
    cardId = card.id;
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "candidate persist failed" };
  }
  try {
    const { row, deduped } = await deps.links.insert({
      incidentId,
      workspaceId,
      postmortemId: pm.id,
      fixCardId: cardId,
      tier: built.candidate.tier,
      verified: true,
      fingerprint: pm.source_fingerprint,
      createdBy: actorUserId,
    });
    return deduped ? { action: "duplicate", link: row, cardId: row.fix_card_id } : { action: "proposed", link: row, cardId };
  } catch (e) {
    return { action: "deferred", reason: e instanceof Error ? e.message : "link persist failed" };
  }
}

// ---- Neon stores (workspace-scoped SQL + audit, mirrors S9–S12) ----

type Sql = <T = Record<string, unknown>[]>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<T>;

async function requireSql(): Promise<Sql> {
  const { dbAvailable } = await import("./db");
  if (!(await dbAvailable())) throw Object.assign(new Error("database unavailable"), { status: 503 });
  const { neon } = await import("@neondatabase/serverless");
  return neon(process.env.DATABASE_URL!.trim()) as unknown as Sql;
}

const LINK_COLS = `id, incident_id, workspace_id, postmortem_id, fix_card_id,
  tier, verified, source_fingerprint, created_by_user_id, created_at`;

function toLink(r: Record<string, unknown>): MemoryLinkRow {
  return {
    id: r.id as string,
    incident_id: r.incident_id as string,
    workspace_id: r.workspace_id as string,
    postmortem_id: r.postmortem_id as string,
    fix_card_id: r.fix_card_id as string,
    tier: r.tier as MemoryTier,
    verified: !!r.verified,
    source_fingerprint: r.source_fingerprint as string,
    created_by_user_id: (r.created_by_user_id as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

export async function realMemoryStore(): Promise<MemoryStore> {
  const sql = await requireSql();
  return {
    findByPostmortem: async (postmortemId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, postmortem_id, fix_card_id,
               tier, verified, source_fingerprint, created_by_user_id, created_at
        from incident_memory_links
        where postmortem_id = ${postmortemId} and workspace_id = ${workspaceId}
        limit 1
      `) as unknown as Record<string, unknown>[];
      return rows[0] ? toLink(rows[0]) : null;
    },
    listApprovedForIncident: async (incidentId, workspaceId) => {
      const rows = (await sql`
        select id, incident_id, workspace_id, postmortem_id, fix_card_id,
               tier, verified, source_fingerprint, created_by_user_id, created_at
        from incident_memory_links
        where incident_id = ${incidentId} and workspace_id = ${workspaceId}
        order by created_at desc
      `) as unknown as Record<string, unknown>[];
      return rows.map(toLink);
    },
    listForCards: async (workspaceId, cardIds) => {
      const clean = [...new Set(cardIds)].slice(0, 20);
      if (clean.length === 0) return new Map();
      const rows = (await sql`
        select id, incident_id, workspace_id, postmortem_id, fix_card_id,
               tier, verified, source_fingerprint, created_by_user_id, created_at
        from incident_memory_links
        where workspace_id = ${workspaceId} and fix_card_id = any(${clean})
      `) as unknown as Record<string, unknown>[];
      const out = new Map<string, MemoryLinkRow>();
      for (const r of rows) {
        const link = toLink(r);
        out.set(link.fix_card_id, link);
      }
      return out;
    },
    insert: async (input) => {
      const rows = (await sql`
        insert into incident_memory_links
          (incident_id, workspace_id, postmortem_id, fix_card_id, tier, verified,
           source_fingerprint, created_by_user_id)
        values (${input.incidentId}, ${input.workspaceId}, ${input.postmortemId},
                ${input.fixCardId}, ${input.tier}, ${input.verified},
                ${input.fingerprint}, ${input.createdBy})
        on conflict (postmortem_id) do nothing
        returning id, incident_id, workspace_id, postmortem_id, fix_card_id,
          tier, verified, source_fingerprint, created_by_user_id, created_at
      `) as unknown as Record<string, unknown>[];
      if (rows[0]) {
        const { recordEvent } = await import("./incidents");
        await recordEvent({
          incidentId: input.incidentId,
          kind: "memory_proposed",
          actorUserId: input.createdBy,
          detail: { postmortemId: input.postmortemId, fixCardId: input.fixCardId, tier: input.tier },
        }).catch(() => null);
        return { row: toLink(rows[0]), deduped: false };
      }
      const winner = (await sql`
        select id, incident_id, workspace_id, postmortem_id, fix_card_id,
               tier, verified, source_fingerprint, created_by_user_id, created_at
        from incident_memory_links
        where postmortem_id = ${input.postmortemId} and workspace_id = ${input.workspaceId}
        limit 1
      `) as unknown as Record<string, unknown>[];
      if (!winner[0]) throw new Error("memory link persist failed");
      return { row: toLink(winner[0]), deduped: true };
    },
  };
}

/** Production wiring: S12 postmortems + closure mode + incident link targets. */
export async function realMemoryDeps(): Promise<MemoryDeps> {
  const links = await realMemoryStore();
  return {
    links,
    loadPostmortem: async (postmortemId, workspaceId) => {
      const { realClosureDeps } = await import("./closure-store");
      const cdeps = await realClosureDeps({ judge: false });
      const row = await cdeps.postmortems.loadById(postmortemId, workspaceId).catch(() => null);
      if (!row) return null;
      return {
        id: row.id,
        incident_id: row.incident_id,
        workspace_id: row.workspace_id,
        status: row.status,
        source_fingerprint: row.source_fingerprint,
        brief_fingerprint: row.brief_fingerprint,
        content: {
          symptoms: row.content.symptoms ?? [],
          outcome: row.content.outcome ?? "",
          rootCause: {
            status: row.content.rootCause?.status ?? "unknown",
            statement: row.content.rootCause?.statement ?? "",
          },
          interventions: (row.content.interventions ?? []).map((i) => ({ id: i.id, status: i.status, ref: i.ref ?? null })),
          watch: {
            status: row.content.watch?.status ?? "none",
            observations: row.content.watch?.observations ?? 0,
            improvements: row.content.watch?.improvements ?? 0,
            regressions: row.content.watch?.regressions ?? 0,
            confirmedBy: row.content.watch?.confirmedBy ?? null,
          },
          unknowns: row.content.unknowns ?? [],
        },
      };
    },
    closureMode: async (incidentId, workspaceId) => {
      const { listIncidentEvents } = await import("./incidents");
      const events = await listIncidentEvents(incidentId, workspaceId).catch(() => []);
      const kinds = new Set(events.map((e) => e.kind));
      if (kinds.has("closure_confirmed")) return "verified";
      if (kinds.has("closure_administrative")) return "administrative";
      return "none";
    },
    linkTargets: async (incidentId, workspaceId) => {
      const { listIncidentCustomers, listIncidentConversations } = await import("./incidents");
      const [customers, conversations] = await Promise.all([
        listIncidentCustomers(incidentId, workspaceId).catch(() => []),
        listIncidentConversations(incidentId, workspaceId).catch(() => []),
      ]);
      return {
        customerId: customers[0]?.customer_id ?? null,
        conversationId: conversations[0]?.conversation_id ?? null,
      };
    },
    createCard: async (input) => {
      const { createPendingFixCard } = await import("./support-ops");
      const card = await createPendingFixCard({
        workspaceId: input.workspaceId,
        customerId: input.customerId,
        conversationId: input.conversationId,
        issueId: null,
        candidateText: input.text,
      });
      return { id: card.id };
    },
  };
}

/**
 * Share-time hook for the Fix Card review route: when an S13-linked card
 * is shared, older shared memories for the same incident are superseded
 * (their blobs stay for audit; recall drops them via the superseded
 * deny-list). Failure-isolated — never breaks the share itself.
 */
export async function linkMemoryShare(
  workspaceId: string,
  fixCardId: string,
  reviewerId: string,
): Promise<{ superseded: string[] }> {
  const store = await realMemoryStore();
  const link = (await store.listForCards(workspaceId, [fixCardId]).catch(() => new Map())).get(fixCardId);
  if (!link) return { superseded: [] };
  const prior = await store.listApprovedForIncident(link.incident_id, workspaceId).catch(() => []);
  const { markFixCardSuperseded, getFixCardForWorkspace } = await import("./support-ops");
  const { recordEvent } = await import("./incidents");
  const superseded: string[] = [];
  for (const p of prior) {
    if (p.fix_card_id === fixCardId) continue;
    try {
      const card = await getFixCardForWorkspace(p.fix_card_id, workspaceId);
      if (!card || card.status !== "shared") continue;
      await markFixCardSuperseded(card.id, fixCardId, reviewerId);
      superseded.push(card.id);
    } catch {
      // Per-card isolation: one stale row never blocks the rest.
    }
  }
  if (superseded.length > 0) {
    await recordEvent({
      incidentId: link.incident_id,
      kind: "memory_superseded",
      actorUserId: reviewerId,
      detail: { postmortemId: link.postmortem_id, fixCardId, superseded },
    }).catch(() => null);
  }
  return { superseded };
}
