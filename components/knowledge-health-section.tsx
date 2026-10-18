import Link from "next/link";
import { realHealthDeps } from "@/lib/knowledge-health-store";
import type { KnowledgeFinding } from "@/lib/knowledge-health";
import KnowledgeHealthActions from "@/components/knowledge-health-actions";

function typeLabel(t: KnowledgeFinding["type"]): { text: string; cls: string } {
  switch (t) {
    case "gap":
      return { text: "KNOWLEDGE GAP", cls: "text-amber-200 border-[rgba(255,180,120,0.4)]" };
    case "contradiction":
      return { text: "POSSIBLE CONTRADICTION — NEEDS REVIEW", cls: "text-red-300 border-[rgba(255,120,120,0.4)]" };
    case "stale":
      return { text: "STALE MEMORY / PROVENANCE", cls: "text-neutral-300 border-[rgba(255,255,255,0.25)]" };
  }
}

/**
 * S14 Knowledge Health: advisory findings from existing support history.
 * Read-only when data is missing; never writes memory, executes, or
 * closes. Degrades without breaking the Fix Cards page.
 */
export default async function KnowledgeHealthSection({
  workspaceSlug,
  workspaceId,
}: {
  workspaceSlug: string;
  workspaceId: string;
}) {
  let open: KnowledgeFinding[] = [];
  let history: KnowledgeFinding[] = [];
  let failed = false;
  let analyzedAt: string | null = null;
  try {
    const deps = await realHealthDeps({ judge: false });
    [open, history] = await Promise.all([
      deps.findings.listOpen(workspaceId).catch(() => []),
      deps.findings.listForWorkspace(workspaceId, 20).catch(() => []),
    ]);
    const past = history.filter((h) => !open.some((o) => o.id === h.id)).slice(0, 5);
    history = past;
    const times = [...open, ...past].map((f) => f.last_seen_at).sort();
    analyzedAt = times.length > 0 ? times[times.length - 1] : null;
  } catch {
    failed = true;
  }

  return (
    <div className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-neutral-100">
          Knowledge Health
          <span className="ml-2 font-mono text-[10px] text-neutral-500">
            advisory only{analyzedAt ? ` · last analysis ${new Date(analyzedAt).toLocaleString()}` : " · never analyzed"}
          </span>
        </h2>
        {!failed && <KnowledgeHealthActions workspaceSlug={workspaceSlug} findingId={null} />}
      </div>

      {failed && (
        <p className="mt-1 text-[11px] text-neutral-500">Health data unavailable right now (database unreachable).</p>
      )}

      {!failed && open.length === 0 && (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          No open findings. Refresh analysis to check recent incidents for knowledge gaps, conflicting guidance, or stale memory provenance.
        </p>
      )}

      {!failed && open.map((f) => {
        const t = typeLabel(f.type);
        const repairable = f.type === "stale" && f.detail.reason === "stale_provenance";
        return (
          <div key={f.id} className="mt-2 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(0,0,0,0.25)] px-3 py-2">
            <p className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${t.cls}`}>{t.text}</span>
              <span className={`rounded border px-1 py-px font-mono text-[10px] ${f.confidence === "high" ? "border-[rgba(119,255,117,0.3)] text-[#9AFF8D]" : "border-[rgba(255,255,255,0.2)] text-neutral-400"}`}>
                {f.confidence === "high" ? "grounded" : "uncertain"}
              </span>
              <span className="font-mono text-[10px] text-neutral-500">{f.status}</span>
              <span className="ml-auto">
                <KnowledgeHealthActions workspaceSlug={workspaceSlug} findingId={f.id} repairable={repairable} />
              </span>
            </p>
            <p className="mt-1 text-[11px] text-neutral-100">{f.title}</p>
            <p className="mt-0.5 text-[11px] text-neutral-400">{f.detail.explanation}</p>
            <p className="mt-0.5 text-[11px] text-neutral-500">
              <span className="text-neutral-500">Why surfaced:</span> {f.detail.whySurfaced}
            </p>
            {f.detail.unverified.length > 0 && (
              <p className="mt-0.5 text-[11px] text-neutral-500">
                <span className="text-neutral-500">Still unverified:</span> {f.detail.unverified.join(" · ")}
              </p>
            )}
            <p className="mt-0.5 flex flex-wrap gap-2 font-mono text-[10px] text-neutral-500">
              {f.detail.refs.incidentIds.map((id) => (
                <Link key={id} href={`/app/workspaces/${workspaceSlug}/incidents/${id}`} className="text-[#9AFF8D] hover:underline">
                  incident {id.slice(0, 8)}
                </Link>
              ))}
              {f.detail.refs.cardIds.map((id) => (
                <span key={id}>fix {id.slice(0, 8)}</span>
              ))}
              {f.detail.refs.postmortemIds.map((id) => (
                <span key={id}>postmortem {id.slice(0, 8)}</span>
              ))}
            </p>
            {f.review_note && <p className="mt-0.5 text-[11px] text-neutral-500">Review: {f.review_note}</p>}
          </div>
        );
      })}

      {!failed && history.length > 0 && (
        <p className="mt-2 text-[10px] text-neutral-600">
          Recent history: {history.map((h) => `${h.type}:${h.status}`).join(" · ")} (dismissed, addressed, and superseded findings are preserved)
        </p>
      )}
      <p className="mt-1 text-[10px] text-neutral-600">
        Findings advise; operators decide. Nothing here rewrites cards, publishes memory, or triggers actions.
      </p>
    </div>
  );
}
