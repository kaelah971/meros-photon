import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getOwnedWorkspace } from "@/lib/db";
import { getWorkspaceStats, listWorkspaceConversations } from "@/lib/support-ops";
import { EmptyState, StatusPill } from "@/components/meros-ui";
import PhotonTestNotify from "@/components/photon-test-notify";

/** Console overview: real Neon-derived counts + entry points. */
export default async function WorkspaceOverview({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { slug } = await params;
  const ws = await getOwnedWorkspace(user.id, slug);
  if (!ws) redirect("/app");

  const stats = await getWorkspaceStats(ws.id);
  const recent = (await listWorkspaceConversations(ws.id)).slice(0, 5);
  const cards = [
    { label: "Open issues", value: stats.openIssues, href: `/app/workspaces/${ws.slug}/conversations` },
    { label: "Customers", value: stats.customers, href: `/app/workspaces/${ws.slug}/customers` },
    { label: "Conversations", value: stats.conversations, href: `/app/workspaces/${ws.slug}/conversations` },
    { label: "Pending Fix Cards", value: stats.pendingFixCards, href: `/app/workspaces/${ws.slug}/fix-cards` },
    { label: "Shared fixes", value: stats.sharedFixes, href: `/app/workspaces/${ws.slug}/shared` },
  ];

  return (
    <div>
      <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-[rgba(119,255,117,0.3)] px-3 py-1 font-display text-[10px] tracking-[0.2em] text-[#9AFF8D]">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-[#77FF75]" />
        MEMORY ACTIVE
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {cards.map((c) => (
          <Link
            key={c.label}
            href={c.href}
            className="rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5 hover:border-[rgba(119,255,117,0.5)]"
          >
            <p className="font-display text-xl font-bold text-neutral-100">{c.value}</p>
            <p className="text-[11px] text-neutral-400">{c.label}</p>
          </Link>
        ))}
      </div>
      <h2 className="mt-5 text-sm font-medium text-neutral-100">Recent activity</h2>
      {recent.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            title="No conversations yet"
            body="Share your support link to start helping customers."
          />
        </div>
      ) : (
        <ul className="mt-2 space-y-2">
          {recent.map((c) => (
            <li key={c.id}>
              <Link
                href={`/app/workspaces/${ws.slug}/conversations/${c.id}`}
                className="flex items-center justify-between gap-2 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2 hover:border-[rgba(119,255,117,0.5)]"
              >
                <span className="truncate text-xs text-neutral-100">{c.title}</span>
                <StatusPill status={c.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      {ws.product_name && (
        <p className="mt-3 text-xs text-neutral-400">Product: {ws.product_name}</p>
      )}
      <PhotonTestNotify workspaceSlug={ws.slug} />
      <div className="mt-3 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
        <p className="text-xs text-neutral-400">Customer support URL</p>
        <div className="mt-1 flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-[#06100B] px-2 py-1.5 font-mono text-[11px] text-[#9AFF8D]">
            /support/{ws.slug}
          </code>
          <Link
            href={`/support/${ws.slug}`}
            className="shrink-0 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D]"
          >
            Open
          </Link>
        </div>
      </div>
    </div>
  );
}
