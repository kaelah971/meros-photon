"use client";

// Client driver for resumable knowledge indexing. POST ../[id]/index does
// one bounded batch per call; this polls until the source reaches a
// terminal state (ready/failed) or the attempt budget runs out — the UI
// can never spin forever, and every stop is resumable via retry.

export type KnowledgeIndexProgress = {
  status: "pending" | "ready" | "failed";
  chunksDone: number;
  chunksTotal: number;
  error?: string;
  sourceId: string;
};

export async function indexOnce(
  workspaceSlug: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<KnowledgeIndexProgress> {
  const res = await fetch(
    `/api/workspaces/${workspaceSlug}/knowledge/${encodeURIComponent(sourceId)}/index`,
    { method: "POST", signal },
  );
  const data = await res.json();
  if (data.ok || data.status === "failed") {
    return {
      status: data.status ?? "pending",
      chunksDone: data.chunksDone ?? 0,
      chunksTotal: data.chunksTotal ?? 0,
      error: data.error,
      sourceId,
    };
  }
  throw new Error(data.error ?? "indexing request failed");
}

export async function pollKnowledgeIndex(
  workspaceSlug: string,
  sourceId: string,
  opts?: {
    onProgress?: (p: KnowledgeIndexProgress) => void;
    signal?: AbortSignal;
    intervalMs?: number;
    maxAttempts?: number;
  },
): Promise<KnowledgeIndexProgress> {
  const intervalMs = opts?.intervalMs ?? 2500;
  const maxAttempts = opts?.maxAttempts ?? 100;
  let last: KnowledgeIndexProgress = { status: "pending", chunksDone: 0, chunksTotal: 0, sourceId };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (opts?.signal?.aborted) return last;
    last = await indexOnce(workspaceSlug, sourceId, opts?.signal);
    opts?.onProgress?.(last);
    if (last.status === "ready" || last.status === "failed") return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}
