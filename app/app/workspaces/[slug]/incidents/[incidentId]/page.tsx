import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getOwnedWorkspace } from "@/lib/db";
import {
  getIncidentForWorkspace,
  listIncidentConversations,
  listIncidentCustomers,
  listIncidentEvents,
  listIncidentEvidence,
  listIncidents,
  type IncidentStatus,
} from "@/lib/incidents";
import { listWorkspaceConversations, listWorkspaceCustomers } from "@/lib/support-ops";
import { formatUtc } from "@/lib/datetime";
import { EmptyState, StatusPill } from "@/components/meros-ui";
import IncidentActions from "@/components/incident-actions";
import EvidenceBrief from "@/components/evidence-brief";
import IncidentSnapshot from "@/components/incident-snapshot";
import IncidentFixMatches from "@/components/incident-fix-matches";

const NEXT: Record<string, string[]> = {
  detected: ["investigating", "dismissed"],
  investigating: ["ready_for_action", "dismissed"],
  ready_for_action: ["recovering", "dismissed"],
  recovering: ["monitoring", "dismissed"],
  monitoring: ["resolved", "recovering", "dismissed"],
  resolved: ["investigating"],
  dismissed: [],
  merged: [],
  split: [],
};

function eventLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

/** Staff incident detail: summary, members, evidence, timeline, actions. */
export default async function IncidentDetail({
  params,
}: {
  params: Promise<{ slug: string; incidentId: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { slug, incidentId } = await params;
  const ws = await getOwnedWorkspace(user.id, slug);
  if (!ws) redirect("/app");

  const incident = await getIncidentForWorkspace(ws.id, incidentId);
  if (!incident) redirect(`/app/workspaces/${slug}/incidents`);

  const [customers, conversations, evidence, events, allConvs, allCusts, allIncidents] =
    await Promise.all([
      listIncidentCustomers(incidentId, ws.id),
      listIncidentConversations(incidentId, ws.id),
      listIncidentEvidence(incidentId, ws.id),
      listIncidentEvents(incidentId, ws.id),
      listWorkspaceConversations(ws.id),
      listWorkspaceCustomers(ws.id),
      listIncidents(ws.id),
    ]);

  const linkedConvIds = new Set(conversations.map((c) => c.conversation_id));
  const linkedCustIds = new Set(customers.map((c) => c.customer_id));
  const unlinkedConversations = allConvs
    .filter((c) => !linkedConvIds.has(c.id))
    .slice(0, 50)
    .map((c) => ({ id: c.id, title: c.title }));
  const unlinkedCustomers = allCusts
    .filter((c) => !linkedCustIds.has(c.id))
    .slice(0, 50)
    .map((c) => ({ id: c.id, label: c.display_name ?? c.id.slice(0, 8) }));
  const mergeTargets = allIncidents
    .filter(
      (i) =>
        i.id !== incident.id &&
        !["resolved", "dismissed", "merged", "split"].includes(i.status),
    )
    .slice(0, 20)
    .map((i) => ({ id: i.id, title: i.title }));

  return (
    <div>
      <Link href={`/app/workspaces/${slug}/incidents`} className="text-[11px] text-[#9AFF8D] hover:underline">
        ← All incidents
      </Link>
      <p className="mt-1 text-sm font-medium text-neutral-100">{incident.title}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
        <StatusPill status={incident.status} />
        <span>severity: {incident.severity}</span>
        <span>updated {formatUtc(incident.updated_at)}</span>
      </p>
      {incident.description && (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-neutral-300">{incident.description}</p>
      )}
      {incident.status === "resolved" && incident.resolution_summary && (
        <div className="mt-2 rounded-md border border-[rgba(119,255,117,0.3)] bg-[rgba(119,255,117,0.06)] px-3 py-2">
          <p className="text-[11px] text-neutral-400">Resolution{incident.resolved_at ? ` · ${formatUtc(incident.resolved_at)}` : ""}</p>
          <p className="mt-0.5 whitespace-pre-wrap text-xs text-neutral-100">{incident.resolution_summary}</p>
        </div>
      )}
      {incident.status === "merged" && incident.merged_into_incident_id && (
        <p className="mt-2 text-[11px] text-neutral-400">
          Merged into{" "}
          <Link href={`/app/workspaces/${slug}/incidents/${incident.merged_into_incident_id}`} className="text-[#9AFF8D] hover:underline">
            {incident.merged_into_incident_id.slice(0, 8)}
          </Link>
        </p>
      )}
      {incident.split_from_incident_id && (
        <p className="mt-2 text-[11px] text-neutral-400">
          Split from{" "}
          <Link href={`/app/workspaces/${slug}/incidents/${incident.split_from_incident_id}`} className="text-[#9AFF8D] hover:underline">
            {incident.split_from_incident_id.slice(0, 8)}
          </Link>
        </p>
      )}

      <h2 className="mt-4 text-xs font-medium text-neutral-100">
        Affected customers ({customers.length})
      </h2>
      {customers.length === 0 ? (
        <p className="mt-1 text-[11px] text-neutral-500">No customers linked yet.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {customers.map((c) => (
            <li key={c.customer_id}>
              <Link
                href={`/app/workspaces/${slug}/conversations?customer=${c.customer_id}`}
                className="block truncate rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-1.5 text-xs text-neutral-200 hover:border-[rgba(119,255,117,0.5)]"
              >
                {c.display_name}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-4 text-xs font-medium text-neutral-100">
        Related conversations ({conversations.length})
      </h2>
      {conversations.length === 0 ? (
        <p className="mt-1 text-[11px] text-neutral-500">No conversations linked yet.</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {conversations.map((c) => (
            <li key={c.conversation_id}>
              <Link
                href={`/app/workspaces/${slug}/conversations/${c.conversation_id}`}
                className="block rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-1.5 hover:border-[rgba(119,255,117,0.5)]"
              >
                <span className="block truncate text-xs text-neutral-100">{c.title}</span>
                <span className="mt-0.5 flex gap-2 text-[11px] text-neutral-500">
                  <StatusPill status={c.status} />
                  <span>{c.customer_display}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-4 text-xs font-medium text-neutral-100">
        Evidence references ({evidence.length})
      </h2>
      {evidence.length === 0 ? (
        <p className="mt-1 text-[11px] text-neutral-500">
          No evidence pinned yet. Evidence here is always a reference to an existing record — never a generated conclusion.
        </p>
      ) : (
        <ul className="mt-1 space-y-1">
          {evidence.map((e) => (
            <li
              key={e.id}
              className="rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-1.5"
            >
              <p className="font-mono text-[10px] text-neutral-500">
                {e.kind}
                {e.ref_conversation_id ? ` · conv ${e.ref_conversation_id.slice(0, 8)}` : ""}
                {e.ref_message_id ? ` · msg ${e.ref_message_id.slice(0, 8)}` : ""}
                {e.ref_fix_card_id ? ` · fix ${e.ref_fix_card_id.slice(0, 8)}` : ""}
                {e.ref_knowledge_id ? ` · kb ${e.ref_knowledge_id.slice(0, 8)}` : ""}
              </p>
              {e.label && <p className="mt-0.5 text-xs text-neutral-100">{e.label}</p>}
              {e.note && <p className="mt-0.5 whitespace-pre-wrap text-[11px] text-neutral-400">{e.note}</p>}
            </li>
          ))}
        </ul>
      )}

      <EvidenceBrief workspaceSlug={slug} workspaceId={ws.id} incidentId={incident.id} />

      <IncidentSnapshot
        workspaceSlug={slug}
        workspaceId={ws.id}
        incident={{
          id: incident.id,
          title: incident.title,
          status: incident.status,
          severity: incident.severity,
          customer_count: customers.length,
          conversation_count: conversations.length,
        }}
      />

      <IncidentFixMatches workspaceSlug={slug} workspaceId={ws.id} incidentId={incident.id} />

      <h2 className="mt-4 text-xs font-medium text-neutral-100">
        Activity ({events.length})
      </h2>
      {events.length === 0 ? (
        <p className="mt-1 text-[11px] text-neutral-500">No activity recorded.</p>
      ) : (
        <ol className="mt-1 space-y-1.5 border-l border-[rgba(119,255,117,0.2)] pl-3">
          {events.map((e) => (
            <li key={e.id}>
              <p className="text-[11px] text-neutral-100">{eventLabel(e.kind)}</p>
              <p className="font-mono text-[10px] text-neutral-500">
                {formatUtc(e.created_at)}
                {Object.keys(e.detail ?? {}).length > 0 ? ` · ${JSON.stringify(e.detail).slice(0, 160)}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}

      <IncidentActions
        workspaceSlug={slug}
        incidentId={incident.id}
        status={incident.status}
        nextStates={NEXT[incident.status as IncidentStatus] ?? []}
        unlinkedConversations={unlinkedConversations}
        unlinkedCustomers={unlinkedCustomers}
        mergeTargets={mergeTargets}
        linkedConversationIds={conversations.map((c) => c.conversation_id)}
        linkedCustomerIds={customers.map((c) => c.customer_id)}
      />
    </div>
  );
}
