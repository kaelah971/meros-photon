import Link from "next/link";
import { getIncidentBrief } from "@/lib/evidence-brief";
import { realMatchStore, type MatchRow } from "@/lib/fix-matches";
import FixMatchesRefreshButton from "@/components/fix-matches-refresh-button";

function tierLabel(tier: MatchRow["tier"]): { text: string; cls: string } {
  switch (tier) {
    case "verified_fix":
      return { text: "VERIFIED HISTORICAL FIX", cls: "border-[rgba(119,255,117,0.4)] text-[#9AFF8D]" };
    case "documented_unverified":
      return { text: "DOCUMENTED BUT UNVERIFIED", cls: "border-[rgba(255,180,120,0.4)] text-amber-200" };
    case "possible_match":
      return { text: "POSSIBLE MATCH", cls: "border-[rgba(255,255,255,0.25)] text-neutral-300" };
  }
}

/**
 * S8 Related Fix Cards: read-only recommendations for the incident's current
 * evidence. Facts cite the brief; historical outcomes are labeled verified
 * vs unverified; applicability warnings are explicit. Stale generations are
 * marked, never presented as current. Degrades without breaking the page.
 */
export default async function IncidentFixMatches({
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
        <h2 className="text-xs font-medium text-neutral-100">Related Fix Cards</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          Matching unavailable right now (database unreachable). Incident data is unaffected.
        </p>
      </div>
    );
  }

  let store: Awaited<ReturnType<typeof realMatchStore>> | null = null;
  try {
    store = await realMatchStore();
  } catch {
    store = null;
  }

  if (!brief || brief.status !== "current") {
    const latest = store ? await store.loadLatest(incidentId, workspaceId).catch(() => null) : null;
    return (
      <div className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-medium text-neutral-100">Related Fix Cards</h2>
          <FixMatchesRefreshButton workspaceSlug={workspaceSlug} incidentId={incidentId} />
        </div>
        <p className="mt-1.5 text-[11px] text-neutral-400">
          {!brief
            ? "No evidence brief yet — matches need a current brief. Nothing recommended."
            : `Brief is ${brief.status} — recommendations refresh when it is current. Nothing recommended from stale evidence.`}
        </p>
        {latest && latest.rows.length > 0 && (
          <p className="mt-1 text-[11px] text-amber-200/90">
            {latest.rows.length} older recommendation(s) from brief fingerprint {latest.fingerprint.slice(0, 8)} are
            superseded — refresh to recompute.
          </p>
        )}
      </div>
    );
  }

  const current = store ? await store.loadForBrief(incidentId, workspaceId, brief.fingerprint).catch(() => []) : [];
  const latest = store ? await store.loadLatest(incidentId, workspaceId).catch(() => null) : null;
  const staleCount = latest && latest.fingerprint !== brief.fingerprint ? latest.rows.length : 0;

  return (
    <div className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-neutral-100">
          Related Fix Cards
          <span className="ml-2 font-mono text-[10px] text-neutral-500">
            brief v{brief.version} · fp {brief.fingerprint.slice(0, 8)}
          </span>
        </h2>
        <FixMatchesRefreshButton workspaceSlug={workspaceSlug} incidentId={incidentId} />
      </div>

      {current.length === 0 ? (
        <div className="mt-1.5">
          <p className="text-[11px] text-neutral-400">
            No relevant historical cases found for the current evidence — no invented matches.
            {staleCount > 0
              ? ` (${staleCount} older recommendation(s) from a previous brief version are superseded.)`
              : ""}
          </p>
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {current.map((m) => {
            const tier = tierLabel(m.tier);
            const p = m.payload;
            return (
              <li
                key={m.id}
                className="rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(0,0,0,0.25)] px-3 py-2"
              >
                <p className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${tier.cls}`}>
                    {tier.text}
                  </span>
                  <Link
                    href={`/app/workspaces/${workspaceSlug}/fix-cards`}
                    className="font-mono text-[10px] text-[#9AFF8D] hover:underline"
                  >
                    fix {m.ref_id.slice(0, 8)} →
                  </Link>
                  <span className="text-[10px] text-neutral-500">
                    {p.cardStatus}
                    {p.cardResolved === true ? " · issue resolved" : ""}
                    {p.cardResolved === false ? " · issue still open" : ""}
                  </span>
                </p>
                {p.reasons.length > 0 && (
                  <div className="mt-1.5">
                    <p className="text-[11px] font-medium text-neutral-300">WHY RELEVANT</p>
                    <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[11px] text-neutral-400">
                      {p.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {p.matchingSymptoms.length > 0 && (
                  <p className="mt-1 text-[11px] text-neutral-400">
                    <span className="text-neutral-500">Shared symptoms:</span> {p.matchingSymptoms.join(" · ")}
                  </p>
                )}
                {p.differences.length > 0 && (
                  <p className="mt-1 text-[11px] text-amber-200/90">
                    <span className="text-neutral-500">Differs:</span> {p.differences.join(" · ")}
                  </p>
                )}
                {p.unknowns.length > 0 && (
                  <p className="mt-1 text-[11px] text-neutral-400">
                    <span className="text-neutral-500">Still to check:</span> {p.unknowns.join(" · ")}
                  </p>
                )}
                {!p.applicable && p.warning && (
                  <p className="mt-1 rounded border border-dashed border-[rgba(255,180,120,0.4)] px-2 py-1 text-[11px] text-amber-200">
                    Not directly applicable: {p.warning}
                  </p>
                )}
                {p.applicable && m.tier !== "verified_fix" && (
                  <p className="mt-1 text-[11px] text-neutral-500">
                    Historical outcome is not verified — treat as a lead, not a prescription.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {staleCount > 0 && current.length > 0 && (
        <p className="mt-1.5 text-[11px] text-amber-200/90">
          {staleCount} older recommendation(s) from a previous brief version are superseded.
        </p>
      )}
      <p className="mt-2 text-[10px] text-neutral-600">
        Read-only history. Meros does not assume the past solution fits — inspect differences before acting.
      </p>
    </div>
  );
}
