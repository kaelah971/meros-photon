import "server-only";

import { checkRedaction } from "./support-memory";

// S15D canonical evidence view-model: one normalized assembly of the
// persisted incident + current S6 brief + authorized source links +
// relevant stored S8 matches + grounded recovery/watch status. The web
// page, the PNG snapshot, and the iMessage text summary all derive from
// THIS model — never from independent AI regeneration.
//
// Privacy: aggregate observations and counts only. No customer names/ids,
// no conversation transcripts, no secrets, no private memory. Incident
// titles are redaction-gated (sensitive titles become a generic heading).

export type EvidenceSourceLink = { messageId: string; conversationId: string };

export type EvidenceFactView = {
  observation: string;
  identifiers: string[];
  sourceMessageIds: string[];
};

export type EvidenceMatchView = {
  refId: string;
  tier: string;
  excerpt: string;
  cardStatus: string;
  cardResolved: boolean | null;
  reasons: string[];
};

export type EvidenceView =
  | {
      ready: false;
      state: "empty" | "pending" | "failed" | "stale" | "unavailable";
      incident: { id: string; title: string; status: string; severity: string };
      heading: string;
      note: string;
    }
  | {
      ready: true;
      incident: { id: string; title: string; status: string; severity: string };
      heading: string;
      briefVersion: number;
      briefFingerprint: string;
      generatedAt: string | null;
      reportCount: number;
      customerCount: number;
      conversationCount: number;
      facts: EvidenceFactView[];
      identifiers: string[];
      corroborated: { pattern: string; sourceCount: number }[];
      contradictions: string[];
      unknowns: string[];
      hypotheses: string[];
      matches: EvidenceMatchView[];
      recovery: {
        plans: { version: number; status: string }[];
        stagedPlans: number;
        approvedApprovals: number;
        unverifiedExecutions: number;
      };
      watch: { status: string; observations: number; improvements: number; regressions: number } | null;
      sources: EvidenceSourceLink[];
      postmortemFinalized: boolean;
    };

const MAX_TITLE = 90;

function clean(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Incident titles are operator-written and may contain sensitive data.
 * Redaction-gated: anything matching a secret/contact pattern becomes a
 * generic heading. Pure and deterministic.
 */
export function safeHeading(title: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  if (!t) return "Incident evidence";
  if (t.length > 400) return "Incident evidence";
  if (!checkRedaction(t).passed) return "Incident evidence";
  return clean(t, MAX_TITLE);
}

export type EvidenceViewInput = {
  incident: {
    id: string;
    title: string;
    status: string;
    severity: string;
    customer_count: number;
    conversation_count: number;
  };
  brief: {
    status: string;
    version: number;
    fingerprint: string;
    generated_at: string | null;
    source_count: number;
    findings: {
      facts: { observation: string; identifiers: string[]; sources: string[] }[];
      corroborated: { pattern: string; sources: string[] }[];
      contradictions: { description: string }[];
      unknowns: string[];
      hypotheses: { text: string }[];
    };
  } | null;
  matches: { refId: string; tier: string; excerpt: string; cardStatus: string; cardResolved: boolean | null; reasons: string[] }[];
  recovery: {
    plans: { version: number; status: string }[];
    approvedApprovals: number;
    unverifiedExecutions: number;
  };
  watch: { status: string; observations: number; improvements: number; regressions: number } | null;
  sourceLinks: EvidenceSourceLink[];
  postmortemFinalized: boolean;
  briefAvailable: boolean;
};

/**
 * Deterministic assembly. Non-current or missing briefs yield an honest
 * non-ready view — never a silently generated "current" snapshot. Facts
 * keep brief order so text, web, and PNG summaries stay consistent.
 */
export function buildEvidenceView(input: EvidenceViewInput): EvidenceView {
  const heading = safeHeading(input.incident.title);
  const base = {
    id: input.incident.id,
    title: input.incident.title,
    status: input.incident.status,
    severity: input.incident.severity,
  };
  const brief = input.brief;
  if (!brief) {
    return {
      ready: false,
      state: input.briefAvailable ? "failed" : "empty",
      incident: base,
      heading,
      note: input.briefAvailable
        ? "Brief assembly failed and no usable brief exists yet. Original evidence is preserved."
        : "No evidence brief yet. Link a conversation with real customer reports and the brief assembles automatically.",
    };
  }
  if (brief.status !== "current") {
    const state = brief.status === "pending" ? "pending" : brief.status === "stale" ? "stale" : brief.status === "failed" ? "failed" : "unavailable";
    return {
      ready: false,
      state,
      incident: base,
      heading,
      note:
        state === "pending"
          ? `Evidence brief v${brief.version} is still assembling from ${brief.source_count} linked report(s).`
          : state === "stale"
            ? `Newer reports arrived after brief v${brief.version} — it is refreshing. This is NOT current.`
            : "The current evidence brief is unavailable right now. Original evidence is preserved.",
    };
  }
  const facts = (brief.findings.facts ?? []).map((f) => ({
    observation: f.observation,
    identifiers: (f.identifiers ?? []).slice(0, 3),
    sourceMessageIds: (f.sources ?? []).slice(0, 6),
  }));
  const identifiers = [...new Set(facts.flatMap((f) => f.identifiers))].slice(0, 12);
  const stagedPlans = input.recovery.plans.filter((p) => p.status === "staged").length;
  return {
    ready: true,
    incident: base,
    heading,
    briefVersion: brief.version,
    briefFingerprint: brief.fingerprint,
    generatedAt: brief.generated_at,
    reportCount: brief.source_count,
    customerCount: input.incident.customer_count,
    conversationCount: input.incident.conversation_count,
    facts,
    identifiers,
    corroborated: (brief.findings.corroborated ?? []).map((c) => ({ pattern: c.pattern, sourceCount: c.sources.length })),
    contradictions: (brief.findings.contradictions ?? []).map((c) => c.description),
    unknowns: [...(brief.findings.unknowns ?? [])],
    hypotheses: (brief.findings.hypotheses ?? []).map((h) => h.text),
    matches: input.matches.map((m) => ({
      refId: m.refId,
      tier: m.tier,
      excerpt: m.excerpt.slice(0, 200),
      cardStatus: m.cardStatus,
      cardResolved: m.cardResolved,
      reasons: m.reasons.slice(0, 3),
    })),
    recovery: {
      plans: input.recovery.plans,
      stagedPlans,
      approvedApprovals: input.recovery.approvedApprovals,
      unverifiedExecutions: input.recovery.unverifiedExecutions,
    },
    watch: input.watch,
    sources: input.sourceLinks,
    postmortemFinalized: input.postmortemFinalized,
  };
}

/**
 * Real assembly from persisted stores. Bounded reads; every failure
 * degrades to an honest non-ready view instead of throwing into the page.
 */
export async function loadEvidenceView(
  incidentId: string,
  workspaceId: string,
): Promise<EvidenceView> {
  const { getIncidentForWorkspace } = await import("./incidents");
  const incident = await getIncidentForWorkspace(workspaceId, incidentId).catch(() => null);
  if (!incident) {
    return {
      ready: false,
      state: "unavailable",
      incident: { id: incidentId, title: "", status: "", severity: "" },
      heading: "Incident evidence",
      note: "Incident not found in this workspace.",
    };
  }
  const base = {
    id: incident.id,
    title: incident.title,
    status: incident.status,
    severity: incident.severity,
    customer_count: incident.customer_count,
    conversation_count: incident.conversation_count,
  };
  const heading = safeHeading(incident.title);

  let brief: EvidenceViewInput["brief"] = null;
  let briefAvailable = false;
  let sourceLinks: EvidenceViewInput["sourceLinks"] = [];
  try {
    const { getIncidentBrief, briefSourceLinks } = await import("./evidence-brief");
    const b = await getIncidentBrief(incidentId, workspaceId);
    if (b) {
      briefAvailable = true;
      sourceLinks = await briefSourceLinks(incidentId, workspaceId).catch(() => []);
      brief = {
        status: b.status,
        version: b.version,
        fingerprint: b.fingerprint,
        generated_at: b.generated_at,
        source_count: b.source_count,
        findings: {
          facts: (b.findings.facts ?? []).map((f) => ({
            observation: f.observation,
            identifiers: f.identifiers ?? [],
            sources: f.sources ?? [],
          })),
          corroborated: (b.findings.corroborated ?? []).map((c) => ({ pattern: c.pattern, sources: c.sources ?? [] })),
          contradictions: (b.findings.contradictions ?? []).map((c) => ({ description: c.description })),
          unknowns: b.findings.unknowns ?? [],
          hypotheses: (b.findings.hypotheses ?? []).map((h) => ({ text: h.text })),
        },
      };
    }
  } catch {
    return {
      ready: false,
      state: "unavailable",
      incident: base,
      heading,
      note: "Evidence is unavailable right now (database unreachable). Original evidence is preserved.",
    };
  }

  // Stored S8 matches for the current brief only — stale matches belong
  // to the incident page's superseded display, not this current record.
  let matches: EvidenceViewInput["matches"] = [];
  try {
    if (brief && brief.status === "current") {
      const { realMatchStore } = await import("./fix-matches");
      const store = await realMatchStore();
      const rows = await store.loadForBrief(incidentId, workspaceId, brief.fingerprint).catch(() => []);
      matches = rows.map((r) => ({
        refId: r.ref_id,
        tier: r.tier,
        excerpt: r.payload.cardExcerpt ?? "",
        cardStatus: r.payload.cardStatus ?? "",
        cardResolved: r.payload.cardResolved ?? null,
        reasons: r.payload.reasons ?? [],
      }));
    }
  } catch {
    matches = [];
  }

  // Grounded recovery + watch status (counts only, details stay on the
  // incident page). Bounded per-plan reads; failures degrade to zeros.
  let plans: { version: number; status: string }[] = [];
  let approvedApprovals = 0;
  let unverifiedExecutions = 0;
  try {
    const { realPlanStore } = await import("./recovery-plans");
    const { realApprovalDeps } = await import("./recovery-approvals");
    const [plansStore, adeps] = await Promise.all([realPlanStore(), realApprovalDeps()]);
    const [active, history] = await Promise.all([
      plansStore.loadActive(incidentId, workspaceId).catch(() => []),
      plansStore.loadHistory(incidentId, workspaceId).catch(() => []),
    ]);
    const seen = new Set<string>();
    for (const p of [...active, ...history]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      plans.push({ version: p.plan_version, status: p.status });
    }
    plans = plans.slice(0, 10);
    const all = [...active, ...history].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i).slice(0, 10);
    for (const p of all) {
      try {
        const [approvals, execs] = await Promise.all([
          adeps.approvals.listForPlan(p.id, workspaceId).catch(() => []),
          adeps.executions.listForPlan(p.id, workspaceId).catch(() => []),
        ]);
        if (approvals.some((a) => a.status === "approved")) approvedApprovals++;
        if (execs.some((e) => e.status === "unknown_outcome")) unverifiedExecutions++;
      } catch {
        // Per-plan isolation: one bad read never blocks the record.
      }
    }
  } catch {
    plans = [];
  }

  let watch: EvidenceViewInput["watch"] = null;
  try {
    const { realWatchDeps } = await import("./resolution-watch-store");
    const wdeps = await realWatchDeps({ judge: false });
    const rows = await wdeps.watches.listForIncident(incidentId, workspaceId).catch(() => []);
    const current = rows.find((w) => w.status !== "resolution_confirmed") ?? rows[0] ?? null;
    if (current) {
      const obs = await wdeps.observations.listForWatch(current.id, workspaceId).catch(() => []);
      watch = {
        status: current.status,
        observations: obs.length,
        improvements: obs.filter((o) => o.kind === "customer_improvement" || o.kind === "verification").length,
        regressions: obs.filter((o) => o.kind === "regression").length,
      };
    }
  } catch {
    watch = null;
  }

  let postmortemFinalized = false;
  try {
    const { realClosureDeps } = await import("./closure-store");
    const cdeps = await realClosureDeps({ judge: false });
    postmortemFinalized = (await cdeps.postmortems.listFinalized(incidentId, workspaceId).catch(() => [])).length > 0;
  } catch {
    postmortemFinalized = false;
  }

  // Customer/conversation counts ship on the incident summary row;
  // no private content leaves the workspace boundary.
  return buildEvidenceView({
    incident: base,
    brief,
    matches,
    recovery: { plans, approvedApprovals, unverifiedExecutions },
    watch,
    sourceLinks,
    postmortemFinalized,
    briefAvailable,
  });
}
