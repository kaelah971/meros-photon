import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getOwnedWorkspace } from "@/lib/db";
import {
  getCandidateForWorkspace,
  listCandidateMembers,
  listCandidateMessages,
} from "@/lib/issue-candidates";
import { listIncidents } from "@/lib/incidents";
import { formatUtc } from "@/lib/datetime";
import { StatusPill } from "@/components/meros-ui";
import CandidateReviewActions from "@/components/candidate-review-actions";

/** Staff review of one detected pattern: evidence, uncertainty, actions. */
export default async function CandidateDetail({
  params,
}: {
  params: Promise<{ slug: string; candidateId: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { slug, candidateId } = await params;
  const ws = await getOwnedWorkspace(user.id, slug);
  if (!ws) redirect("/app");

  const candidate = await getCandidateForWorkspace(ws.id, candidateId);
  if (!candidate) redirect(`/app/workspaces/${slug}/incidents`);

  const [members, messages, incidents] = await Promise.all([
    listCandidateMembers(candidateId, ws.id),
    listCandidateMessages(candidateId, ws.id, 20),
    listIncidents(ws.id),
  ]);
  const openIncidents = incidents
    .filter((i) => !["resolved", "dismissed", "merged", "split"].includes(i.status))
    .slice(0, 20)
    .map((i) => ({ id: i.id, title: i.title, status: i.status }));

  return (
    <div>
      <Link href={`/app/workspaces/${slug}/incidents`} className="text-[11px] text-[#9AFF8D] hover:underline">
        ← Incident Center
      </Link>
      <p className="mt-1 rounded-md border border-[rgba(255,180,120,0.35)] bg-[rgba(40,26,8,0.5)] px-2 py-1 text-[10px] tracking-[0.2em] text-amber-200">
        DETECTED PATTERN — UNCONFIRMED
      </p>
      <p className="mt-1 text-sm font-medium text-neutral-100">{candidate.title}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
        <StatusPill status={candidate.status} />
        <span>confidence: {candidate.confidence}</span>
        <span>
          {candidate.conversation_count} conversation{candidate.conversation_count === 1 ? "" : "s"} ·{" "}
          {candidate.customer_count} customer{candidate.customer_count === 1 ? "" : "s"} · {candidate.message_count} report{candidate.message_count === 1 ? "" : "s"}
        </span>
      </p>
      {candidate.summary && (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-neutral-300">{candidate.summary}</p>
      )}
      <div className="mt-2 rounded-md border border-[rgba(255,255,255,0.1)] bg-[#06100B] px-3 py-2">
        <p className="text-[11px] text-neutral-400">Why Meros thinks these are related</p>
        <p className="mt-0.5 text-xs text-neutral-200">{candidate.rationale || "No rationale recorded."}</p>
        <p className="mt-1 text-[10px] text-neutral-500">
          First seen {formatUtc(candidate.first_seen_at)} · last seen {formatUtc(candidate.last_seen_at)} · match quality is an estimate, not verified evidence.
        </p>
      </div>

      <h2 className="mt-4 text-xs font-medium text-neutral-100">Source reports ({messages.length})</h2>
      {messages.length === 0 ? (
        <p className="mt-1 text-[11px] text-neutral-500">No source messages retained.</p>
      ) : (
        <ul className="mt-1 space-y-1.5">
          {messages.map((m) => (
            <li key={m.message_id} className="rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2">
              <p className="whitespace-pre-wrap text-xs text-neutral-200">{m.content.slice(0, 500)}</p>
              <Link
                href={`/app/workspaces/${slug}/conversations/${m.conversation_id}`}
                className="mt-1 inline-block text-[11px] text-[#9AFF8D] hover:underline"
              >
                Open conversation →
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-4 text-xs font-medium text-neutral-100">Member conversations ({members.length})</h2>
      {members.length === 0 ? (
        <p className="mt-1 text-[11px] text-neutral-500">None.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {members.map((m) => (
            <li key={m.conversation_id}>
              <Link
                href={`/app/workspaces/${slug}/conversations/${m.conversation_id}`}
                className="block truncate rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-1.5 text-xs text-neutral-200 hover:border-[rgba(119,255,117,0.5)]"
              >
                {m.title ?? m.conversation_id.slice(0, 8)}
              </Link>
            </li>
          ))}
        </ul>
      )}

      {candidate.status === "pending" ? (
        <CandidateReviewActions
          workspaceSlug={slug}
          candidateId={candidate.id}
          incidents={openIncidents}
        />
      ) : (
        <p className="mt-4 text-[11px] text-neutral-500">
          {candidate.status === "accepted" && candidate.accepted_incident_id ? (
            <>Accepted — see <Link href={`/app/workspaces/${slug}/incidents/${candidate.accepted_incident_id}`} className="text-[#9AFF8D] hover:underline">linked incident</Link>.</>
          ) : (
            <>Dismissed{candidate.dismissal_note ? `: ${candidate.dismissal_note}` : " — unchanged evidence will not re-surface this."}</>
          )}
        </p>
      )}
    </div>
  );
}
