import Link from "next/link";
import { briefSourceLinks, getIncidentBrief } from "@/lib/evidence-brief";
import { formatUtc } from "@/lib/datetime";
import { StatusPill } from "@/components/meros-ui";

function statusLabel(status: string): string {
  switch (status) {
    case "current":
      return "current";
    case "pending":
      return "assembling";
    case "stale":
      return "stale — refreshing";
    case "failed":
      return "failed";
    default:
      return status;
  }
}

/**
 * S6 Evidence Brief: source-backed findings for a confirmed incident.
 * Facts cite real messages; hypotheses are labeled unverified; empty
 * incidents show an honest empty state instead of invented intelligence.
 */
export default async function EvidenceBrief({
  workspaceSlug,
  workspaceId,
  incidentId,
}: {
  workspaceSlug: string;
  workspaceId: string;
  incidentId: string;
}) {
  let brief: Awaited<ReturnType<typeof getIncidentBrief>>;
  try {
    brief = await getIncidentBrief(incidentId, workspaceId);
  } catch {
    return (
      <div className="mt-4">
        <h2 className="text-xs font-medium text-neutral-100">Evidence Brief</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          Brief unavailable right now (database unreachable). Original evidence is preserved; it will assemble automatically.
        </p>
      </div>
    );
  }
  if (!brief) {
    return (
      <div className="mt-4">
        <h2 className="text-xs font-medium text-neutral-100">Evidence Brief</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          No brief yet. Link a conversation with real customer reports and the brief assembles automatically.
        </p>
      </div>
    );
  }
  const f = brief.findings ?? { facts: [], corroborated: [], contradictions: [], unknowns: [], hypotheses: [] };
  const links = await briefSourceLinks(incidentId, workspaceId).catch(() => []);
  const convOf = new Map(links.map((l) => [l.messageId, l.conversationId]));
  const hrefFor = (messageId: string) => {
    const conv = convOf.get(messageId);
    return conv ? `/app/workspaces/${workspaceSlug}/conversations/${conv}` : undefined;
  };

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-neutral-100">Evidence Brief</h2>
        <span className="flex items-center gap-2 text-[11px] text-neutral-500">
          <StatusPill status={brief.status} />
          <span>{statusLabel(brief.status)}</span>
          {brief.generated_at && <span>· {formatUtc(brief.generated_at)}</span>}
          <span>· {brief.source_count} reports</span>
        </span>
      </div>
      {brief.status === "failed" && (
        <p className="mt-1 text-[11px] text-red-300">
          Assembly failed{brief.error ? `: ${brief.error}` : ""}. Original evidence is preserved; the next linked report retries.
        </p>
      )}
      {brief.status === "pending" && (
        <p className="mt-1 text-[11px] text-neutral-500">Assembling from linked customer reports…</p>
      )}
      {brief.status === "stale" && (
        <p className="mt-1 text-[11px] text-amber-200/90">Newer reports arrived — refreshing the brief.</p>
      )}

      {f.facts.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-neutral-300">WHAT WE KNOW</p>
          <ul className="mt-1 space-y-1.5">
            {f.facts.map((fact, i) => (
              <li key={i} className="rounded-md border border-[rgba(119,255,117,0.18)] bg-[rgba(10,27,18,0.72)] px-3 py-2">
                <p className="text-xs text-neutral-100">{fact.observation}</p>
                {fact.identifiers.length > 0 && (
                  <p className="mt-0.5 font-mono text-[10px] text-neutral-500">{fact.identifiers.join(" · ")}</p>
                )}
                <p className="mt-1 flex flex-wrap gap-1.5">
                  {fact.sources.map((s) => {
                    const href = hrefFor(s);
                    return href ? (
                      <Link key={s} href={href} className="font-mono text-[10px] text-[#9AFF8D] hover:underline">
                        msg {s.slice(0, 8)} →
                      </Link>
                    ) : (
                      <span key={s} className="font-mono text-[10px] text-neutral-500">msg {s.slice(0, 8)}</span>
                    );
                  })}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {f.corroborated.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-neutral-300">CORROBORATED BY INDEPENDENT REPORTS</p>
          <ul className="mt-1 space-y-1.5">
            {f.corroborated.map((c, i) => (
              <li key={i} className="rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2">
                <p className="text-xs text-neutral-100">{c.pattern}</p>
                <p className="mt-1 text-[10px] text-neutral-500">
                  {c.sources.length} independent reports · {c.sources.map((s) => s.slice(0, 8)).join(", ")}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {f.contradictions.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-neutral-300">WHAT DIFFERS</p>
          <ul className="mt-1 space-y-1.5">
            {f.contradictions.map((c, i) => (
              <li key={i} className="rounded-md border border-[rgba(255,180,120,0.3)] bg-[rgba(40,26,8,0.5)] px-3 py-2">
                <p className="text-xs text-neutral-100">{c.description}</p>
                <p className="mt-1 flex gap-1.5">
                  {c.between.map((s) => {
                    const href = hrefFor(s);
                    return href ? (
                      <Link key={s} href={href} className="font-mono text-[10px] text-[#9AFF8D] hover:underline">
                        msg {s.slice(0, 8)} →
                      </Link>
                    ) : (
                      <span key={s} className="font-mono text-[10px] text-neutral-500">msg {s.slice(0, 8)}</span>
                    );
                  })}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {f.unknowns.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-neutral-300">WHAT WE DON&apos;T KNOW</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-neutral-400">
            {f.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </div>
      )}

      {f.hypotheses.length > 0 && (
        <div className="mt-2 rounded-md border border-dashed border-[rgba(255,255,255,0.2)] px-3 py-2">
          <p className="text-[11px] font-medium text-neutral-300">POSSIBLE EXPLANATIONS — UNVERIFIED HYPOTHESES</p>
          <ul className="mt-1 space-y-1.5">
            {f.hypotheses.map((h, i) => (
              <li key={i} className="text-[11px] text-neutral-400">
                <span className="text-neutral-500">[unverified hypothesis]</span> {h.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {f.facts.length === 0 && f.unknowns.length === 0 && brief.status === "current" && (
        <p className="mt-1 text-[11px] text-neutral-500">No supportable findings from the current evidence.</p>
      )}
    </div>
  );
}
