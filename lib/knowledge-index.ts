import { chunkText } from "./knowledge";
import type { KnowledgeChunkRow } from "./db";

// Bounded, resumable knowledge indexing. Each call writes at most
// INDEX_CHUNKS_PER_CALL Walrus blobs and returns — never a minutes-long
// await inside one serverless invocation. Progress persists per chunk, so
// an interrupted run (timeout, retry, double-submit) resumes where it
// stopped instead of restarting. Status is ready iff ALL chunks stored.

export const INDEX_CHUNKS_PER_CALL = 3;
export const INDEX_CHUNK_TIMEOUT_MS = 20_000;
export const INDEX_MAX_CHUNKS = 20;

export type IndexStatus = "pending" | "ready" | "failed";

export type IndexDeps = {
  listChunks: () => Promise<Pick<KnowledgeChunkRow, "position" | "walrus_blob_id">[]>;
  saveChunk: (chunk: { content: string; position: number; blobId: string | null }) => Promise<void>;
  setStatus: (status: IndexStatus) => Promise<void>;
  remember: (text: string) => Promise<string | null>;
};

export type IndexResult = {
  status: IndexStatus;
  chunksDone: number;
  chunksTotal: number;
  error?: string;
};

/**
 * Index one bounded batch of canonical-text chunks. Throws only when the
 * progress reads/writes themselves are unreachable (caller degrades
 * honestly); Walrus failures resolve to failed, never throw.
 */
export async function indexNextBatch(
  canonical: string,
  deps: IndexDeps,
  maxChunks: number = INDEX_CHUNKS_PER_CALL,
): Promise<IndexResult> {
  const chunks = chunkText(canonical).slice(0, INDEX_MAX_CHUNKS);
  if (chunks.length === 0) {
    await deps.setStatus("ready");
    return { status: "ready", chunksDone: 0, chunksTotal: 0 };
  }
  const existing = await deps.listChunks();
  const done = new Map<number, string | null>();
  for (const row of existing) {
    if (row.position >= 0 && row.position < chunks.length && !done.has(row.position)) {
      done.set(row.position, row.walrus_blob_id);
    }
  }
  if (done.size >= chunks.length) {
    await deps.setStatus("ready");
    return { status: "ready", chunksDone: chunks.length, chunksTotal: chunks.length };
  }
  await deps.setStatus("pending");
  let processed = 0;
  for (let i = 0; i < chunks.length && processed < maxChunks; i++) {
    if (done.has(i)) continue;
    let blobId: string | null;
    try {
      blobId = await deps.remember(`[KNOWLEDGE] ${chunks[i]}`);
    } catch (e) {
      await deps.setStatus("failed");
      return {
        status: "failed",
        chunksDone: done.size,
        chunksTotal: chunks.length,
        error: e instanceof Error ? e.message : "walrus write failed",
      };
    }
    await deps.saveChunk({ content: chunks[i], position: i, blobId });
    done.set(i, blobId);
    processed++;
  }
  if (done.size >= chunks.length) {
    await deps.setStatus("ready");
    return { status: "ready", chunksDone: chunks.length, chunksTotal: chunks.length };
  }
  return { status: "pending", chunksDone: done.size, chunksTotal: chunks.length };
}
