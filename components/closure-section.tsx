import { checkEligibility, type PostmortemContent, type PostmortemRow } from "@/lib/closure";
import { realClosureDeps } from "@/lib/closure-store";
import { realMemoryStore, type MemoryLinkRow } from "@/lib/operator-memory";
import { getFixCardForWorkspace } from "@/lib/support-ops";
import ClosureActions from "@/components/closure-actions";
import MemoryCandidateActions from "@/components/memory-candidate-actions";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <p className="text-[11px] font-medium text-neutral-300">{title}</p>
      <div className="mt-0.5 text-[11px] text-neutral-400">{children}</div>
    </div>
  );
}

function PostmortemCard({ pm, historic }: { pm: PostmortemRow; historic?: boolean }) {
  const c = pm.content as PostmortemContent;
  return (
    <div className="mt-2 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(0,0,0,0.25)] px-3 py-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${pm.status === "finalized" ? "border-[rgba(119,255,117,0.4)] text-[#9AFF8D]" : "border-[rgba(255,255,255,0.25)] text-neutral-300"}`}>
          {pm.status === "finalized" ? "FINALIZED POSTMORTEM" : "DRAFT POSTMORTEM — under review"}
        </span>
        <span className="font-mono text-[10px] text-neutral-500">
          fp {pm.source_fingerprint.slice(0, 8)}
          {pm.finalized_at ? ` · finalized ${new Date(pm.finalized_at).toLocaleString()}` : ""}
          {historic ? " · historical (survived reopening)" : ""}
        </span>
      </p>
      <p className="mt-1.5 text-xs text-neutral-100">{c.title} <span className="text-neutral-500">[{c.severity}]</span></p>

      <Section title="WHAT HAPPENED">
        {c.symptoms.length > 0 ? c.symptoms.map((s, i) => <p key={i}>• {s}</p>) : <p>No grounded symptoms recorded.</p>}
      </Section>

      <Section title="CUSTOMER IMPACT (documented only)">
        <p>
          {c.impact.documentedCustomers} linked customer(s), {c.impact.documentedConversations} linked conversation(s).{" "}
          {c.impact.note}
        </p>
      </Section>

      {c.facts.length > 0 && (
        <Section title="VERIFIED FACTS + SOURCES">
          {c.facts.slice(0, 10).map((f, i) => (
            <p key={i}>• {f.statement} <span className="font-mono text-[10px] text-neutral-600">[{f.sources.join(", ") || "brief"}]</span></p>
          ))}
        </Section>
      )}

      <Section title="TIMELINE">
        {c.chronology.length > 0 ? (
          <ol className="space-y-0.5">
            {c.chronology.slice(0, 30).map((t, i) => (
              <li key={i} className="font-mono text-[10px] text-neutral-500">
                {new Date(t.at).toLocaleString()} · {t.kind} · <span className="text-neutral-400">{t.detail.slice(0, 120)}</span>
              </li>
            ))}
            {c.chronology.length > 30 && <li className="text-neutral-600">+{c.chronology.length - 30} more events preserved in history</li>}
          </ol>
        ) : <p>No timeline events recorded.</p>}
      </Section>

      <Section title="INVESTIGATION">
        {c.investigation.length > 0 ? c.investigation.map((s, i) => <p key={i}>• {s}</p>) : <p>No investigation milestones recorded.</p>}
        {c.historicalBasis.length > 0 && (
          <p className="mt-0.5 text-neutral-500">
            Historical leads consulted: {c.historicalBasis.map((h) => `${h.refId.slice(0, 8)}[${h.tier}]`).join(", ")}
          </p>
        )}
      </Section>

      <Section title="INTERVENTIONS (recorded, not presumed effective)">
        {c.recoveryProposals.length > 0 ? c.recoveryProposals.map((p, i) => <p key={i}>• plan v{p.planVersion} {p.status}</p>) : <p>No recovery proposals recorded.</p>}
        {c.approvals.length > 0 && <p>• approvals: {c.approvals.map((a) => `${a.id.slice(0, 8)}:${a.status}`).join(", ")}</p>}
        {c.interventions.length > 0 && <p>• manual records: {c.interventions.map((e) => `${e.id.slice(0, 8)}:${e.status}`).join(", ")}</p>}
      </Section>

      <Section title="OUTCOME">
        <p>{c.outcome}</p>
        <p className="mt-0.5 text-neutral-500">Watch: {c.watch.status} · {c.watch.observations} observations ({c.watch.improvements} improvement, {c.watch.regressions} regression).</p>
      </Section>

      <Section title="ROOT CAUSE">
        <p>
          [{c.rootCause.status.toUpperCase()}] {c.rootCause.statement}
        </p>
      </Section>

      {c.unknowns.length > 0 && (
        <Section title="UNKNOWNS">
          {c.unknowns.map((u, i) => <p key={i}>• {u}</p>)}
        </Section>
      )}

      {(c.lessons.length > 0 || c.prevention.length > 0) && (
        <Section title="SUGGESTED LESSONS (model leads — verify before acting)">
          {c.lessons.map((l, i) => <p key={i}>• {l.text} <span className="font-mono text-[10px] text-neutral-600">[{l.basedOn.join(", ")}]</span></p>)}
          {c.prevention.map((l, i) => <p key={i}>• prevent: {l.text} <span className="font-mono text-[10px] text-neutral-600">[{l.basedOn.join(", ")}]</span></p>)}
        </Section>
      )}

      <p className="mt-1 text-[10px] text-neutral-600">{c.synthesisNote}</p>
      {pm.note && <p className="mt-0.5 text-[11px] text-neutral-500">Review note: {pm.note}</p>}
    </div>
  );
}

function MemoryBlock({
  workspaceSlug,
  incidentId,
  postmortemId,
  links,
  cardStatusByLink,
}: {
  workspaceSlug: string;
  incidentId: string;
  postmortemId: string;
  links: MemoryLinkRow[];
  cardStatusByLink: Map<string, string>;
}) {
  return (
    <div className="mt-1 rounded border border-[rgba(255,255,255,0.08)] px-2 py-1.5">
      <p className="text-[11px] font-medium text-neutral-300">
        OPERATOR MEMORY
        <span className="ml-2 font-normal text-neutral-500">reviewed knowledge only — never automatic</span>
      </p>
      {links.length === 0 && (
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
          No memory candidate proposed from this postmortem yet.
          <MemoryCandidateActions workspaceSlug={workspaceSlug} incidentId={incidentId} postmortemId={postmortemId} />
        </p>
      )}
      {links.map((l) => {
        const cardStatus = cardStatusByLink.get(l.id) ?? "unknown";
        return (
          <p key={l.id} className="mt-0.5 font-mono text-[10px] text-neutral-400">
            candidate {l.tier === "verified_fix" ? "verified outcome" : "unverified"} · fix {l.fix_card_id.slice(0, 8)} · {cardStatus}
            {cardStatus === "pending_review" && " — awaiting staff review in Fix Cards"}
            {cardStatus === "shared" && " — approved shared memory, recalled by future matching"}
          </p>
        );
      })}
    </div>
  );
}

/**
 * S12 closure + postmortems. Read-only when data is missing; never
 * executes, sends, or auto-closes. Degrades without breaking the page.
 */
export default async function ClosureSection({
  workspaceSlug,
  workspaceId,
  incidentId,
}: {
  workspaceSlug: string;
  workspaceId: string;
  incidentId: string;
}) {
  let eligible = false;
  let blockers: string[] = [];
  let draft: PostmortemRow | null = null;
  let finalized: PostmortemRow[] = [];
  let memoryLinks: MemoryLinkRow[] = [];
  let cardStatusByLink = new Map<string, string>();
  let failed = false;
  try {
    const deps = await realClosureDeps({ judge: false });
    const e = await checkEligibility(incidentId, workspaceId, deps);
    if (e.eligible) {
      eligible = true;
      draft = await deps.postmortems.loadById(e.draftId, workspaceId).catch(() => null);
    } else {
      blockers = e.blockers;
    }
    const [d, f] = await Promise.all([
      deps.postmortems.loadDraft(incidentId, workspaceId).catch(() => null),
      deps.postmortems.listFinalized(incidentId, workspaceId).catch(() => []),
    ]);
    if (!draft) draft = d;
    finalized = f;
    try {
      const mstore = await realMemoryStore();
      memoryLinks = await mstore.listApprovedForIncident(incidentId, workspaceId).catch(() => []);
      const statuses = await Promise.all(
        memoryLinks.map(async (l) => ({
          id: l.id,
          status: (await getFixCardForWorkspace(l.fix_card_id, workspaceId).catch(() => null))?.status ?? "unknown",
        })),
      );
      cardStatusByLink = new Map(statuses.map((s) => [s.id, s.status]));
    } catch {
      memoryLinks = [];
    }
  } catch {
    failed = true;
  }

  return (
    <div id="closure-readiness" className="mt-4 scroll-mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-neutral-100">Closure Readiness</h2>
        {!failed && (
          <ClosureActions workspaceSlug={workspaceSlug} incidentId={incidentId} draftId={draft?.id ?? null} eligible={eligible} />
        )}
      </div>

      {failed && (
        <p className="mt-1 text-[11px] text-neutral-500">Closure data unavailable right now (database unreachable). Incident data is unaffected.</p>
      )}

      {!failed && (
        <p className="mt-1 flex flex-wrap items-center gap-2">
          <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${eligible ? "border-[rgba(119,255,117,0.4)] text-[#9AFF8D]" : "border-[rgba(255,180,120,0.4)] text-amber-200"}`}>
            {eligible ? "ELIGIBLE FOR CLOSURE" : "NOT ELIGIBLE"}
          </span>
        </p>
      )}

      {!failed && !eligible && blockers.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {blockers.map((b, i) => (
            <li key={i} className="text-[11px] text-amber-200/90">• {b}</li>
          ))}
        </ul>
      )}

      {!failed && draft && <PostmortemCard pm={draft} />}

      {!failed && !draft && finalized.length === 0 && (
        <p className="mt-1 text-[11px] text-neutral-500">
          No postmortem yet. Generate a draft to assemble the factual record for review — closure needs an eligible watch plus a current draft.
        </p>
      )}

      {!failed && finalized.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-neutral-300">FINALIZED HISTORY (survives reopening)</p>
          {finalized.slice(0, 3).map((p) => (
            <span key={p.id} className="block">
              <PostmortemCard pm={p} historic={draft?.id !== p.id} />
              <MemoryBlock
                workspaceSlug={workspaceSlug}
                incidentId={incidentId}
                postmortemId={p.id}
                links={memoryLinks.filter((l) => l.postmortem_id === p.id)}
                cardStatusByLink={cardStatusByLink}
              />
            </span>
          ))}
        </div>
      )}
      <p className="mt-1 text-[10px] text-neutral-600">
        Verified execution alone, silence, and old Fix Cards never prove recovery. Nothing here is promoted to shared memory.
      </p>
    </div>
  );
}
