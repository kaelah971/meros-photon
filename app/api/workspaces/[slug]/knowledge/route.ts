import { NextResponse } from "next/server";
import { requireDb, requireUser } from "@/lib/auth";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  getKnowledgeSource,
  getOwnedWorkspace,
  listKnowledgeSources,
  updateKnowledgeSource,
} from "@/lib/db";
import {
  KNOWLEDGE_TYPES,
  capCanonical,
  chunkText,
  importWebsite,
  validatePublicUrl,
  type KnowledgeType,
} from "@/lib/knowledge";

function err(e: unknown, fallback: string, status = 500) {
  const s =
    e instanceof Error && typeof (e as Error & { status?: unknown }).status === "number"
      ? ((e as Error & { status?: number }).status as number)
      : status;
  return NextResponse.json(
    { ok: false, error: e instanceof Error ? e.message : fallback },
    { status: s },
  );
}

async function ownedWorkspace(userId: string, slug: string) {
  const ws = await getOwnedWorkspace(userId, slug);
  return ws;
}

/** List knowledge sources (metadata only — canonical text stays queryable per source). */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  try {
    await requireDb();
    const user = await requireUser();
    const { slug } = await ctx.params;
    const ws = await ownedWorkspace(user.id, slug);
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    const rows = await listKnowledgeSources(ws.id);
    return NextResponse.json({
      ok: true,
      sources: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        sourceUrl: r.source_url,
        status: r.status,
        updatedAt: r.updated_at,
        contentChars: r.canonical_content.length,
      })),
    });
  } catch (e) {
    return err(e, "request failed");
  }
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  if (!t) return null;
  return t.slice(0, max);
}

/**
 * Indexing runs separately (POST ../[id]/index, bounded batches) — this
 * route only persists canonical text durably and returns fast, so long
 * manuals can never wedge a serverless request. Reconcile-first: an
 * explicit sourceId resumes that source; otherwise an identical
 * pending/failed source is reused instead of duplicating on retry.
 */
function chunksTotalFor(canonical: string): number {
  return chunkText(canonical).slice(0, 20).length;
}

async function reconcileSource(args: {
  workspaceId: string;
  sourceId: string | null;
  type: string;
  title: string;
  canonical: string;
}): Promise<{ id: string; status: string; chunksTotal: number; resumed: boolean } | null> {
  const { getKnowledgeSource: get, listKnowledgeSources: list } = await import("@/lib/db");
  if (args.sourceId) {
    const existing = await get(args.sourceId, args.workspaceId);
    if (existing && (existing.status === "pending" || existing.status === "failed")) {
      return { id: existing.id, status: existing.status, chunksTotal: chunksTotalFor(existing.canonical_content), resumed: true };
    }
    return null;
  }
  const rows = await list(args.workspaceId);
  const dup = rows.find(
    (r) =>
      r.type === args.type &&
      r.title === args.title &&
      r.canonical_content === args.canonical &&
      (r.status === "pending" || r.status === "failed"),
  );
  if (!dup) return null;
  return { id: dup.id, status: dup.status, chunksTotal: chunksTotalFor(dup.canonical_content), resumed: true };
}

/**
 * Create a knowledge source. Manual: {type, title, content}.
 * Website/documentation: {type, title?, url} — imports, then indexes.
 * URL failures return 502 with the source left failed (onboarding continues
 * with manual knowledge). No invented facts: only imported/manual text.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  let body: { type?: unknown; title?: unknown; content?: unknown; url?: unknown; sourceId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  try {
    await requireDb();
    const user = await requireUser();
    const { slug } = await ctx.params;
    const ws = await ownedWorkspace(user.id, slug);
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });

    const type = typeof body.type === "string" ? body.type : "manual";
    if (!(KNOWLEDGE_TYPES as readonly string[]).includes(type)) {
      return NextResponse.json({ ok: false, error: "unknown knowledge type" }, { status: 400 });
    }
    const resumeId = typeof body.sourceId === "string" ? body.sourceId : null;

    let title = str(body.title, 160);
    let canonical: string;
    let sourceUrl: string | null = null;

    if (type === "manual" || type === "faq" || type === "policy") {
      const content = str(body.content, 100_000);
      if (!content || content.length < 20) {
        return NextResponse.json(
          { ok: false, error: "content must be at least 20 characters" },
          { status: 400 },
        );
      }
      canonical = capCanonical(content).text;
      title = title ?? `${type[0].toUpperCase()}${type.slice(1)} notes`;
    } else {
      // website | documentation: import first, fail honestly on walls.
      const rawUrl = typeof body.url === "string" ? body.url : "";
      try {
        validatePublicUrl(rawUrl);
      } catch (e) {
        return NextResponse.json(
          { ok: false, error: e instanceof Error ? e.message : "invalid URL" },
          { status: 400 },
        );
      }
      sourceUrl = rawUrl.trim();
      let pages;
      try {
        pages = await importWebsite(sourceUrl);
      } catch (e) {
        const failed = await createKnowledgeSource({
          workspaceId: ws.id,
          type: type as KnowledgeType,
          title: title ?? sourceUrl,
          sourceUrl,
          canonicalContent: "",
        });
        await updateKnowledgeSource(failed.id, ws.id, { status: "failed" });
        return NextResponse.json(
          { ok: false, error: e instanceof Error ? e.message : "import failed", sourceId: failed.id },
          { status: 502 },
        );
      }
      const combined = pages.pages.map((p) => `Source: ${p.url}\n\n${p.text}`).join("\n\n---\n\n");
      canonical = capCanonical(combined).text;
      title = title ?? pages.pages[0].url;
    }

    // Reconcile before creating: resume an in-flight source or reuse an
    // identical pending/failed one, so retries and double-clicks never
    // duplicate. Only then persist (fast — indexing runs separately).
    const reconciled = await reconcileSource({
      workspaceId: ws.id,
      sourceId: resumeId,
      type,
      title: title!,
      canonical,
    });
    if (reconciled) {
      const existing = await getKnowledgeSource(reconciled.id, ws.id);
      return NextResponse.json(
        {
          ok: true,
          resumed: true,
          source: {
            id: reconciled.id,
            type: existing?.type ?? type,
            title: existing?.title ?? title,
            sourceUrl: existing?.source_url ?? sourceUrl,
            status: reconciled.status,
            chunksTotal: reconciled.chunksTotal,
          },
        },
        { status: 200 },
      );
    }
    const row = await createKnowledgeSource({
      workspaceId: ws.id,
      type: type as KnowledgeType,
      title: title!,
      sourceUrl,
      canonicalContent: canonical,
    });
    // Durably persisted as pending — indexing proceeds separately via
    // POST ../[id]/index (bounded batches), so this response stays fast.
    return NextResponse.json(
      {
        ok: true,
        source: { id: row.id, type, title, sourceUrl, status: "pending", chunksTotal: chunksTotalFor(canonical) },
      },
      { status: 201 },
    );
  } catch (e) {
    return err(e, "request failed");
  }
}

/** Update canonical text (re-indexes) or delete a source. Metadata only. */
export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  let body: { id?: unknown; title?: unknown; content?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  try {
    await requireDb();
    const user = await requireUser();
    const { slug } = await ctx.params;
    const ws = await ownedWorkspace(user.id, slug);
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    if (typeof body.id !== "string") {
      return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    }
    const existing = await getKnowledgeSource(body.id, ws.id);
    if (!existing) return NextResponse.json({ ok: false, error: "source not found" }, { status: 404 });
    const content = str(body.content, 100_000);
    const title = str(body.title, 160);
    if ((content && content.length < 20) || (!content && !title)) {
      return NextResponse.json({ ok: false, error: "nothing valid to update" }, { status: 400 });
    }
    const canonical = content ? capCanonical(content).text : existing.canonical_content;
    // Resume path: the client already holds this source (retry/double-click).
    await updateKnowledgeSource(existing.id, ws.id, {
      ...(title ? { title } : {}),
      ...(content ? { canonicalContent: canonical, status: "pending" as const } : {}),
    });
    // Edits persist fast as pending — the client drives POST ../[id]/index
    // until ready/failed, so long rewrites can't wedge the request either.
    const row = await getKnowledgeSource(existing.id, ws.id);
    return NextResponse.json({
      ok: true,
      source: {
        id: row!.id,
        status: row!.status,
        chunksTotal: content ? chunksTotalFor(canonical) : undefined,
      },
    });
  } catch (e) {
    return err(e, "request failed");
  }
}

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  try {
    await requireDb();
    const user = await requireUser();
    const { slug } = await ctx.params;
    const ws = await ownedWorkspace(user.id, slug);
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    if (!id) return NextResponse.json({ ok: false, error: "id is required" }, { status: 400 });
    const gone = await deleteKnowledgeSource(id, ws.id);
    if (!gone) return NextResponse.json({ ok: false, error: "source not found" }, { status: 404 });
    return NextResponse.json({ ok: true, deleted: id });
  } catch (e) {
    return err(e, "request failed");
  }
}
