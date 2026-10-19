import { NextResponse } from "next/server";
import { requireDb, requireUser } from "@/lib/auth";
import {
  getKnowledgeSource,
  getOwnedWorkspace,
  listKnowledgeChunks,
  saveKnowledgeChunk,
  updateKnowledgeSource,
} from "@/lib/db";
import { deriveKnowledgeNamespaceV2 } from "@/lib/tenant";
import { INDEX_CHUNK_TIMEOUT_MS, indexNextBatch } from "@/lib/knowledge-index";
import { rememberPrivate } from "@/lib/walrus";

// Bounded indexing slice: at most a few Walrus writes per call, progress
// persisted per chunk. Clients poll until pending resolves to ready/failed.
// A platform timeout mid-call only delays — done chunks persist, the next
// call resumes. Never reports ready until every chunk is stored.
export const maxDuration = 60;

export async function POST(_req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  try {
    await requireDb();
    const user = await requireUser();
    const { slug, id } = await ctx.params;
    const ws = await getOwnedWorkspace(user.id, slug);
    if (!ws) return NextResponse.json({ ok: false, error: "workspace not found" }, { status: 404 });
    const source = await getKnowledgeSource(id, ws.id);
    if (!source) return NextResponse.json({ ok: false, error: "source not found" }, { status: 404 });
    if (source.status === "ready") {
      return NextResponse.json({ ok: true, status: "ready", sourceId: source.id });
    }
    const namespace = deriveKnowledgeNamespaceV2(ws.id);
    const result = await indexNextBatch(source.canonical_content, {
      listChunks: () => listKnowledgeChunks(source.id, ws.id),
      saveChunk: (c) =>
        saveKnowledgeChunk({ knowledgeId: source.id, workspaceId: ws.id, ...c }),
      setStatus: async (status) => {
        await updateKnowledgeSource(source.id, ws.id, { status });
      },
      remember: async (text) => {
        const done = await rememberPrivate(namespace, text, { timeoutMs: INDEX_CHUNK_TIMEOUT_MS });
        return done.blobId;
      },
    });
    return NextResponse.json({ ok: result.status !== "failed", ...result, sourceId: source.id });
  } catch (e) {
    const s =
      e instanceof Error && typeof (e as Error & { status?: unknown }).status === "number"
        ? ((e as Error & { status?: number }).status as number)
        : 500;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "indexing failed" },
      { status: s },
    );
  }
}
