import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getOwnedWorkspace } from "@/lib/db";
import { WorkspaceAccess } from "@/components/workspace-access";
import { loginUrl } from "@/lib/return-to";
import { ConsoleShell, PageBackdrop, type ConsoleNavItem } from "@/components/meros-ui";

const NAV: ConsoleNavItem[] = [
  { label: "Overview", href: "" },
  { label: "Conversations", href: "/conversations" },
  { label: "Customers", href: "/customers" },
  { label: "Incidents", href: "/incidents" },
  { label: "Fix Cards", href: "/fix-cards" },
  { label: "Shared memory", href: "/shared" },
  { label: "Knowledge", href: "/knowledge" },
];

/**
 * Staff console shell. Membership is verified on EVERY render: session
 * user → organization_members → workspace. Unknown vs. foreign slugs show
 * the SAME access screen (no org enumeration, no private details). The
 * middleware already preserved the exact destination for anonymous
 * visitors; here an unauthenticated fallback keeps the workspace root.
 */
export default async function WorkspaceLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: React.ReactNode;
}) {
  const user = await currentUser();
  const { slug } = await params;
  if (!user) redirect(loginUrl(`/app/workspaces/${slug}`));
  const ws = await getOwnedWorkspace(user.id, slug);
  if (!ws) {
    return (
      <div className="relative min-h-screen bg-[#030806] text-[#F5F7F5]">
        <WorkspaceAccess email={user.email} slug={slug} />
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-[#030806] text-[#F5F7F5]">
      <PageBackdrop />
      <ConsoleShell
        orgName={ws.organization_name}
        workspaceName={ws.name}
        workspaceSlug={ws.slug}
        role={ws.role}
        email={user.email}
        displayName={user.displayName}
        nav={NAV.map((item) => ({
          ...item,
          href: `/app/workspaces/${ws.slug}${item.href}`,
        }))}
      >
        {children}
        <p className="mt-6 text-xs text-[#8E9B93]">
          <Link href="/app" className="text-[#9AFF8D] hover:underline">
            ← All organizations
          </Link>
        </p>
      </ConsoleShell>
    </div>
  );
}
