import { NextResponse } from "next/server";
import { identityError, resolveProductIdentity } from "@/lib/product-identity";
import { getConversationForCustomer, listMessages } from "@/lib/support-ops";

/** One own conversation thread, with stored provenance for Memory Lens. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const url = new URL(req.url);
  const workspaceSlug = url.searchParams.get("workspaceSlug") ?? undefined;
  let tenant: Awaited<ReturnType<typeof resolveProductIdentity>>;
  try {
    tenant = await resolveProductIdentity({ workspaceSlug });
  } catch (e) {
    const err = identityError(e);
    return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
  }
  const { id } = await ctx.params;
  try {
    const conversation = await getConversationForCustomer(id, tenant.workspaceId, tenant.customerId);
    if (!conversation) {
      return NextResponse.json({ ok: false, error: "conversation not found" }, { status: 404 });
    }
    const messages = await listMessages(id);
    return NextResponse.json({
      ok: true,
      conversation: {
        id: conversation.id,
        title: conversation.title,
        status: conversation.status,
        resolvedAt: conversation.resolved_at,
      },
      messages: messages.map((m) => ({
        role: m.role,
        text: m.content,
        author: m.role === "assistant" ? (m.author_kind === "staff" ? "staff" : "ai") : undefined,
        memoryUsed: {
          private: m.memory_private_used,
          shared: m.memory_shared_used,
          knowledge: m.memory_knowledge_used,
        },
        provenance: m.memory_provenance ?? [],
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "thread unavailable" },
      { status: 503 },
    );
  }
}
