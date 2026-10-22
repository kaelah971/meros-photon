import "server-only";

import type { DecisionItem, InvestigateReads } from "./investigate";

// Production read wiring for the S15C router: bounded, workspace-scoped
// reads across S4/S5/S6/S8/S9/S10. No mutations, no sends.

export function realInvestigateReads(): InvestigateReads {
  return {
    workspaceSlug: async (workspaceId) => {
      const { getWorkspaceById } = await import("../db");
      const ws = await getWorkspaceById(workspaceId).catch(() => null);
      return ws ? ws.slug : null;
    },
    listActiveIncidents: async (workspaceId) => {
      const { listIncidents } = await import("../incidents");
      const rows = await listIncidents(workspaceId, null).catch(() => []);
      return rows
        .filter((r) => !["resolved", "dismissed", "merged", "split"].includes(r.status))
        .slice(0, 10)
        .map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          severity: r.severity,
          customers: r.customer_count,
          conversations: r.conversation_count,
          evidence: r.evidence_count,
          updatedAt: r.updated_at,
        }));
    },
    listReviewCandidates: async (workspaceId) => {
      const { listCandidates } = await import("../issue-candidates");
      const rows = await listCandidates(workspaceId, { status: "pending" }).catch(() => []);
      return rows.slice(0, 10).map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        status: r.status,
        confidence: r.confidence,
        rationale: r.rationale,
        acceptedIncidentId: r.accepted_incident_id,
        conversations: r.conversation_count,
        customers: r.customer_count,
        messages: r.message_count,
        updatedAt: r.updated_at,
      }));
    },
    getCandidate: async (id, workspaceId) => {
      const { getCandidateForWorkspace, listCandidateMembers, listCandidateMessages } = await import("../issue-candidates");
      const c = await getCandidateForWorkspace(workspaceId, id).catch(() => null);
      if (!c) return null;
      const [members, messages] = await Promise.all([
        listCandidateMembers(id, workspaceId).catch(() => []),
        listCandidateMessages(id, workspaceId, 1).catch(() => []),
      ]);
      return {
        id: c.id,
        title: c.title,
        summary: c.summary,
        status: c.status,
        confidence: c.confidence,
        rationale: c.rationale,
        acceptedIncidentId: c.accepted_incident_id,
        conversations: members.length,
        customers: new Set(members.map((m) => m.customer_id)).size,
        messages: messages.length,
        updatedAt: c.updated_at,
      };
    },
    getIncident: async (id, workspaceId) => {
      const { getIncidentForWorkspace } = await import("../incidents");
      const r = await getIncidentForWorkspace(workspaceId, id).catch(() => null);
      return r
        ? {
            id: r.id,
            title: r.title,
            status: r.status,
            severity: r.severity,
            customers: r.customer_count,
            conversations: r.conversation_count,
            evidence: r.evidence_count,
            updatedAt: r.updated_at,
          }
        : null;
    },
    getBrief: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("../evidence-brief");
      const b = await getIncidentBrief(incidentId, workspaceId).catch(() => null);
      if (!b) return null;
      return {
        status: b.status,
        version: b.version,
        fingerprint: b.fingerprint,
        generatedAt: b.generated_at,
        facts: (b.findings.facts ?? []).map((f) => ({ observation: f.observation, sources: f.sources ?? [] })),
        unknowns: b.findings.unknowns ?? [],
        contradictions: (b.findings.contradictions ?? []).map((c) => c.description ?? "contradiction"),
      };
    },
    getMatches: async (incidentId, workspaceId) => {
      const { getIncidentBrief } = await import("../evidence-brief");
      const { realMatchStore } = await import("../fix-matches");
      const store = await realMatchStore();
      const brief = await getIncidentBrief(incidentId, workspaceId).catch(() => null);
      const fp = brief?.fingerprint ?? null;
      const rows =
        brief && brief.status === "current"
          ? await store.loadForBrief(incidentId, workspaceId, brief.fingerprint).catch(() => [])
          : ((await store.loadLatest(incidentId, workspaceId).catch(() => null))?.rows ?? []);
      return {
        current: !!brief && brief.status === "current",
        fingerprint: fp,
        rows: rows.map((r) => ({
          refId: r.ref_id,
          tier: r.tier,
          reasons: r.payload.reasons ?? [],
          symptoms: r.payload.matchingSymptoms ?? [],
          applicable: r.payload.applicable,
          warning: r.payload.warning ?? "",
          cardStatus: r.payload.cardStatus ?? "",
          cardResolved: r.payload.cardResolved ?? null,
          excerpt: r.payload.cardExcerpt ?? "",
        })),
      };
    },
    listDecisions: async (workspaceId) => {
      const items: DecisionItem[] = [];
      try {
        const { listCandidates } = await import("../issue-candidates");
        const pending = (await listCandidates(workspaceId, { status: "pending" }).catch(() => [])).filter((c) => c.surfaced);
        for (const c of pending.slice(0, 5)) {
          items.push({ kind: "candidate", label: `Review candidate: ${c.title.slice(0, 80)} (${c.conversation_count} convos)`, ref: c.id });
        }
      } catch { /* best-effort per source */ }
      try {
        const { listIncidents } = await import("../incidents");
        const { realPlanStore } = await import("../recovery-plans");
        const { realApprovalDeps } = await import("../recovery-approvals");
        const plans = await realPlanStore();
        const adeps = await realApprovalDeps();
        const open = (await listIncidents(workspaceId, null).catch(() => [])).filter(
          (r) => !["resolved", "dismissed", "merged", "split"].includes(r.status),
        ).slice(0, 10);
        for (const inc of open) {
          const active = await plans.loadActive(inc.id, workspaceId).catch(() => []);
          for (const p of active) {
            if (p.status === "draft" || p.status === "under_review") {
              items.push({ kind: "plan", label: `Review plan v${p.plan_version} for "${inc.title.slice(0, 50)}" (${p.status})`, ref: p.id });
            }
            if (p.status === "staged") {
              const approvals = await adeps.approvals.listForPlan(p.id, workspaceId).catch(() => []);
              if (approvals.some((a) => a.status === "requested")) {
                items.push({ kind: "approval", label: `Approval requested for plan v${p.plan_version} ("${inc.title.slice(0, 50)}")`, ref: p.id });
              }
              const execs = await adeps.executions.listForPlan(p.id, workspaceId).catch(() => []);
              if (execs.some((e) => e.status === "unknown_outcome")) {
                items.push({ kind: "execution", label: `Manual work awaiting verification ("${inc.title.slice(0, 50)}")`, ref: p.id });
              }
            }
          }
          if (items.length >= 12) break;
        }
      } catch { /* best-effort per source */ }
      return items.slice(0, 8);
    },
    recentRadarAlerts: async (workspaceId, operatorUserId) => {
      const { listRecentRadarAlerts } = await import("./history");
      const rows = await listRecentRadarAlerts({ workspaceId, operatorUserId }).catch(() => []);
      return rows.map((r) => ({ candidateId: r.candidateId, createdAt: r.createdAt }));
    },
  };
}
