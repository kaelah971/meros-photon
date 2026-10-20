import React from "react";
import { notFound } from "next/navigation";
import { SupportChat } from "@/components/support-chat";
import { CustomerGate } from "@/components/customer-gate";
import { currentUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";

/**
 * Real product customer route. Workspace comes from the URL and is resolved
 * server-side. Anonymous visitors get the customer auth gate (same Better
 * Auth system as owners); signed-in customers go straight into chat with
 * session-derived identity. No access codes anywhere on this route.
 */
export default async function SupportPage({
  params,
}: {
  params: Promise<{ workspaceSlug: string }>;
}) {
  const { workspaceSlug } = await params;
  const ws = await getWorkspaceBySlug(workspaceSlug);
  if (!ws) notFound();
  const user = await currentUser();
  if (!user) {
    return <CustomerGate workspaceName={ws.name} />;
  }
  return (
    <SupportChat
      initialWorkspaceSlug={ws.slug}
      initialWorkspaceName={ws.name}
      lockWorkspace
      sessionEmail={user.email}
    />
  );
}
