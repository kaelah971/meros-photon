import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getOwnedWorkspace } from "@/lib/db";
import { listIncidentConversations, listIncidentCustomers } from "@/lib/incidents";
import { loadEvidenceView } from "@/lib/evidence-view";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <h2 className="text-xs font-medium text-neutral-100">{title}</h2>
      <div className="mt-1 text-[11px] leading-5 text-neutral-300">{children}</div>
    </div>
  );
}

function Tier({ tier }: { tier: string }) {
  const label =
    tier === "verified_fix"
      ? "VERIFIED HISTORICAL FIX"
      : tier === "documented_unverified"
        ? "DOCUMENTED BUT UNVERIFIED"
        : "POSSIBLE MATCH";
  const cls =
    tier === "verified_fix"
      ? "border-[rgba(119,255,117,0.4)] text-[#9AFF8D]"
      : tier === "documented_unverified"
        ? "border-[rgba(255,180,120,0.4)] text-amber-200"
        : "border-[rgba(255,255,255,0.25)] text-neutral-300";
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${cls}`}>{label}</span>;
}

/**
 * S15D dedicated evidence record: the full inspectable view of one
 * incident's persisted evidence. Staff-only; nothing here executes,
 * sends, or closes. Degrades without breaking navigation.
 */
export default async function IncidentEvidencePage({
  params,
}: {
  params: Promise<{ slug: string; incidentId: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { slug, incidentId } = await params;
  const ws = await getOwnedWorkspace(user.id, slug);
  if (!ws) redirect("/app");

  let view: Awaited<ReturnType<typeof loadEvidenceView>> | null = null;
  try {
    view = await loadEvidenceView(incidentId, ws.id);
  } catch {
    view = null;
  }
  if (!view) {
    return (
      <div className="px-3 py-4">
        <p className="text-sm text-neutral-100">Incident evidence</p>
        <p className="mt-1 text-[11px] text-neutral-500">
          Evidence is unavailable right now (database unreachable). Original evidence is preserved.
        </p>
        <p className="mt-2 text-[11px]">
          <Link className="text-[#9AFF8D] hover:underline" href={`/app/workspaces/${slug}/incidents/${incidentId}`}>
            ← Back to incident
          </Link>
        </p>
      </div>
    );
  }

  const convOf = new Map<string, string>();
  let customers: { customer_id: string; display_name: string | null }[] = [];
  let conversations: { conversation_id: string; title: string; customer_display: string | null }[] = [];
  if (view.ready) {
    for (const s of view.sources) convOf.set(s.messageId, s.conversationId);
    try {
      const [cu, co] = await Promise.all([
        listIncidentCustomers(incidentId, ws.id).catch(() => []),
        listIncidentConversations(incidentId, ws.id).catch(() => []),
      ]);
      customers = cu;
      conversations = co;
    } catch {
      customers = [];
      conversations = [];
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-3 py-4">
      <p className="text-[11px]">
        <Link className="text-[#9AFF8D] hover:underline" href={`/app/workspaces/${slug}/incidents/${incidentId}`}>
          ← Back to incident
        </Link>
      </p>
      <h1 className="mt-1 text-base font-medium text-neutral-100">Incident evidence</h1>
      <p className="mt-0.5 font-mono text-[10px] text-neutral-500">
        {view.incident.id.slice(0, 8)} · status {view.incident.status || "unknown"} · severity {view.incident.severity || "unknown"}
      </p>

      {!view.ready && (
        <div className="mt-3 rounded-md border border-[rgba(255,180,120,0.35)] bg-[rgba(30,20,8,0.6)] px-3 py-2.5">
          <p className="text-[11px] text-amber-200">Evidence {view.state} — not current.</p>
          <p className="mt-1 text-[11px] text-neutral-400">{view.note}</p>
        </div>
      )}

      {view.ready && (
        <>
          <div className="mt-3 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
            <p className="text-xs font-medium text-neutral-100">{view.heading}</p>
            <p className="mt-1 font-mono text-[10px] text-neutral-500">
              brief v{view.briefVersion} · fp {view.briefFingerprint.slice(0, 8)} · current
              {view.generatedAt ? ` · refreshed ${new Date(view.generatedAt).toLocaleString()}` : ""}
            </p>
            <p className="mt-1 text-[11px] text-neutral-300">
              {view.reportCount} report(s) · {view.customerCount} customer(s) · {view.conversationCount} conversation(s)
            </p>
            {view.identifiers.length > 0 && (
              <p className="mt-1 font-mono text-[10px] text-neutral-400">identifiers: {view.identifiers.join(" · ")}</p>
            )}
          </div>

          <Section title={`What we know (${view.facts.length})`}>
            {view.facts.length === 0 && <p className="text-neutral-500">No supportable findings in the current evidence.</p>}
            <ul className="space-y-1.5">
              {view.facts.map((f, i) => (
                <li key={i} className="rounded border border-[rgba(255,255,255,0.08)] px-2 py-1.5">
                  <p>{f.observation}</p>
                  {f.identifiers.length > 0 && <p className="font-mono text-[10px] text-neutral-500">tags: {f.identifiers.join(" · ")}</p>}
                  {f.sourceMessageIds.length > 0 && (
                    <p className="mt-0.5 flex flex-wrap gap-2 font-mono text-[10px]">
                      {f.sourceMessageIds.slice(0, 4).map((mid) => {
                        const cid = convOf.get(mid);
                        return cid ? (
                          <Link key={mid} className="text-[#9AFF8D] hover:underline" href={`/app/workspaces/${slug}/conversations/${cid}`}>
                            msg {mid.slice(0, 8)}
                          </Link>
                        ) : (
                          <span key={mid} className="text-neutral-600">msg {mid.slice(0, 8)}</span>
                        );
                      })}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </Section>

          {view.corroborated.length > 0 && (
            <Section title={`Corroborated (${view.corroborated.length})`}>
              {view.corroborated.map((c, i) => (
                <p key={i}>• {c.pattern} <span className="text-neutral-500">({c.sourceCount} independent reports)</span></p>
              ))}
            </Section>
          )}

          {view.contradictions.length > 0 && (
            <Section title={`Contradictions (${view.contradictions.length})`}>
              {view.contradictions.map((c, i) => (
                <p key={i} className="text-amber-200/90">• {c}</p>
              ))}
            </Section>
          )}

          {view.unknowns.length > 0 && (
            <Section title="Still unknown">
              {view.unknowns.map((u, i) => (
                <p key={i}>• {u}</p>
              ))}
            </Section>
          )}

          {view.hypotheses.length > 0 && (
            <Section title="Possible explanations — unverified, not confirmed">
              {view.hypotheses.map((h, i) => (
                <p key={i}>• [unverified hypothesis] {h}</p>
              ))}
            </Section>
          )}

          <Section title={`Linked customers (${customers.length}) · conversations (${conversations.length})`}>
            {customers.length === 0 && conversations.length === 0 && <p className="text-neutral-500">None linked yet.</p>}
            {customers.slice(0, 10).map((c) => (
              <p key={c.customer_id}>• {c.display_name ?? c.customer_id.slice(0, 8)}</p>
            ))}
            {conversations.slice(0, 10).map((c) => (
              <p key={c.conversation_id}>
                • <Link className="text-[#9AFF8D] hover:underline" href={`/app/workspaces/${slug}/conversations/${c.conversation_id}`}>
                  {c.title || c.conversation_id.slice(0, 8)}
                </Link>
                {c.customer_display ? <span className="text-neutral-500"> — {c.customer_display}</span> : null}
              </p>
            ))}
          </Section>

          <Section title={`Historical Fix Cards (${view.matches.length})`}>
            {view.matches.length === 0 && <p className="text-neutral-500">No stored matches for the current brief. Absence of matches is not proof of novelty.</p>}
            <ul className="space-y-1.5">
              {view.matches.slice(0, 6).map((m) => (
                <li key={m.refId} className="rounded border border-[rgba(255,255,255,0.08)] px-2 py-1.5">
                  <p className="flex flex-wrap items-center gap-2">
                    <Tier tier={m.tier} />
                    <span className="font-mono text-[10px] text-neutral-500">
                      fix {m.refId.slice(0, 8)} · {m.cardStatus}
                      {m.cardResolved === true ? " · issue resolved" : ""}
                      {m.cardResolved === false ? " · issue still open" : ""}
                    </span>
                  </p>
                  {m.reasons[0] && <p className="mt-0.5">{m.reasons[0]}</p>}
                  {m.excerpt && <p className="mt-0.5 text-neutral-500">“{m.excerpt.slice(0, 160)}”</p>}
                  {m.tier !== "verified_fix" && <p className="mt-0.5 text-neutral-500">A lead for investigation, not a prescription.</p>}
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Recovery & verification status">
            <p>
              Plans: {view.recovery.plans.length > 0 ? view.recovery.plans.map((p) => `v${p.version} ${p.status}`).join(" · ") : "none"} ·
              staged: {view.recovery.stagedPlans} · approved: {view.recovery.approvedApprovals} · unverified manual work: {view.recovery.unverifiedExecutions}
            </p>
            <p className="mt-1">
              Watch: {view.watch ? `${view.watch.status} · ${view.watch.observations} observations (${view.watch.improvements} improvement, ${view.watch.regressions} regression)` : "no watch yet"}
              {view.postmortemFinalized ? " · postmortem finalized" : ""}
            </p>
          </Section>

          <Section title="Snapshot image (same evidence, branded)">
            <p className="mb-2">
              <a
                className="inline-block rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)]"
                href={`/api/incidents/${view.incident.id}/evidence-image?workspaceSlug=${encodeURIComponent(slug)}`}
                download={`meros-evidence-${view.incident.id.slice(0, 8)}-v${view.briefVersion}.png`}
              >
                Download PNG snapshot
              </a>
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/incidents/${view.incident.id}/evidence-image?workspaceSlug=${encodeURIComponent(slug)}`}
              alt={`Meros evidence snapshot for incident ${view.incident.id.slice(0, 8)}, brief v${view.briefVersion}`}
              width={1200}
              height={675}
              className="w-full rounded-md border border-[rgba(255,255,255,0.12)]"
            />
            <p className="mt-1 text-[10px] text-neutral-600">
              Rendered server-side from the brief above (v{view.briefVersion}, fp {view.briefFingerprint.slice(0, 8)}). Private to staff; never cached publicly.
            </p>
          </Section>
        </>
      )}
    </div>
  );
}
