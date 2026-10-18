import Link from "next/link";
import { headers } from "next/headers";
import { getIncidentBrief } from "@/lib/evidence-brief";
import { buildSnapshot } from "@/lib/incident-snapshot";
import SnapshotSendButton from "@/components/snapshot-send-button";

/**
 * S7 incident snapshot preview: deterministic rendering of the persisted S6
 * brief (same text that sends). Non-current briefs show an explicit,
 * non-sendable state. Unavailable brief state degrades without breaking the
 * incident page.
 */
export default async function IncidentSnapshot({
  workspaceSlug,
  workspaceId,
  incident,
}: {
  workspaceSlug: string;
  workspaceId: string;
  incident: {
    id: string;
    title: string;
    status: string;
    severity: string;
    customer_count: number;
    conversation_count: number;
  };
}) {
  let brief: Awaited<ReturnType<typeof getIncidentBrief>>;
  try {
    brief = await getIncidentBrief(incident.id, workspaceId);
  } catch {
    return (
      <div className="mt-4">
        <h2 className="text-xs font-medium text-neutral-100">Evidence Snapshot</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          Snapshot unavailable right now (database unreachable). Nothing was sent.
        </p>
      </div>
    );
  }

  let origin = "https://meros-photon.vercel.app";
  try {
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "https";
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) origin = `${proto}://${host}`;
  } catch {
    // Relative preview still renders; the send route builds its own URL.
  }
  const snapshot = buildSnapshot({
    incident,
    brief: brief
      ? {
          status: brief.status,
          version: brief.version,
          fingerprint: brief.fingerprint,
          findings: brief.findings,
          source_count: brief.source_count,
          generated_at: brief.generated_at,
        }
      : null,
    incidentUrl: `${origin}/app/workspaces/${workspaceSlug}/incidents/${incident.id}`,
  });

  return (
    <div className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-neutral-100">Evidence Snapshot</h2>
        <p className="font-mono text-[10px] text-neutral-500">
          {snapshot.state === "ready"
            ? `brief v${snapshot.briefVersion} · fp ${snapshot.fingerprint.slice(0, 8)}`
            : snapshot.state}
        </p>
      </div>
      <pre className="mt-1.5 whitespace-pre-wrap font-sans text-[11px] leading-5 text-neutral-300">
        {snapshot.text}
      </pre>
      <p className="mt-2 text-[11px]">
        <Link
          className="text-[#9AFF8D] hover:underline"
          href={`/app/workspaces/${workspaceSlug}/incidents/${incident.id}/evidence`}
        >
          Open full evidence record →
        </Link>
      </p>
      {snapshot.sendable ? (
        <SnapshotSendButton
          key={snapshot.fingerprint}
          workspaceSlug={workspaceSlug}
          incidentId={incident.id}
          expectedFingerprint={snapshot.fingerprint}
          briefVersion={snapshot.briefVersion}
        />
      ) : (
        <p className="mt-2 text-[11px] text-amber-200/90">
          Not sendable while the brief is {snapshot.state} — the preview above says what to do next.
        </p>
      )}
    </div>
  );
}
