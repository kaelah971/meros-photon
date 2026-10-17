import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getOwnedWorkspace } from "@/lib/db";
import { listIncidents, type IncidentStatus } from "@/lib/incidents";
import { listCandidates } from "@/lib/issue-candidates";
import { listWorkspaceConversations } from "@/lib/support-ops";
import { formatUtc } from "@/lib/datetime";
import { EmptyState, StatusPill } from "@/components/meros-ui";
import IncidentCreateForm from "@/components/incident-create-form";

const FILTERS = ["all", "detected", "investigating", "ready_for_action", "recovering", "monitoring", "resolved", "dismissed"] as const;

/** Staff Incident Center: workspace-scoped list with status filter. */
export default async function IncidentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ status?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { slug } = await params;
  const ws = await getOwnedWorkspace(user.id, slug);
  if (!ws) redirect("/app");

  const rawStatus = (await searchParams)?.status ?? "all";
  const filter = (FILTERS as readonly string[]).includes(rawStatus) && rawStatus !== "all"
    ? (rawStatus as IncidentStatus)
    : null;
  const [incidents, conversations, reviewQueue] = await Promise.all([
    listIncidents(ws.id, filter),
    listWorkspaceConversations(ws.id),
    listCandidates(ws.id, { surfacedOnly: true }),
  ]);
  const needsReview = reviewQueue.filter((c) => c.status === "pending" && c.surfaced);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-100">Incidents ({incidents.length})</p>
        <IncidentCreateForm
          workspaceSlug={slug}
          conversations={conversations.slice(0, 50).map((c) => ({ id: c.id, title: c.title }))}
        />
      </div>
      {needsReview.length > 0 && (
        <div className="mt-3 rounded-md border border-[rgba(255,180,120,0.35)] bg-[rgba(40,26,8,0.5)] px-3 py-2">
          <p className="text-xs font-medium text-amber-200">Needs review ({needsReview.length}) — detected patterns</p>
          <ul className="mt-1.5 space-y-1.5">
            {needsReview.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/app/workspaces/${slug}/incidents/detected/${c.id}`}
                  className="block rounded-md border border-[rgba(255,180,120,0.25)] bg-[#06100B] px-3 py-2 hover:border-[rgba(255,180,120,0.6)]"
                >
                  <span className="block text-xs font-medium text-neutral-100">{c.title}</span>
                  <span className="mt-0.5 flex flex-wrap gap-2 font-mono text-[11px] text-neutral-500">
                    <span>{c.conversation_count} conversations · {c.customer_count} customers</span>
                    <span>confidence: {c.confidence}</span>
                    <span>seen {formatUtc(c.last_seen_at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={f === "all" ? `/app/workspaces/${slug}/incidents` : `/app/workspaces/${slug}/incidents?status=${f}`}
            className={`rounded-full border px-2.5 py-1 text-[11px] ${
              (filter ?? "all") === f
                ? "border-[rgba(119,255,117,0.5)] text-[#9AFF8D]"
                : "border-[rgba(255,255,255,0.14)] text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {f.replace(/_/g, " ")}
          </Link>
        ))}
      </div>
      {incidents.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            title={filter ? `No ${filter.replace(/_/g, " ")} incidents` : "No incidents yet"}
            body={
              conversations.length === 0
                ? "When support conversations show a repeated problem, create the first incident here."
                : "Create an incident to track a repeated customer problem across conversations."
            }
          />
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {incidents.map((i) => (
            <li key={i.id}>
              <Link
                href={`/app/workspaces/${slug}/incidents/${i.id}`}
                className="block rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2 hover:border-[rgba(119,255,117,0.5)]"
              >
                <span className="text-xs font-medium text-neutral-100">{i.title}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-neutral-500">
                  <StatusPill status={i.status} />
                  <span>severity: {i.severity}</span>
                  <span>{i.customer_count} customer{i.customer_count === 1 ? "" : "s"}</span>
                  <span>{i.conversation_count} conversation{i.conversation_count === 1 ? "" : "s"}</span>
                  <span>{formatUtc(i.updated_at)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
