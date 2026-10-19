import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexNextBatch, type IndexDeps } from "../knowledge-index";
import { chunkText } from "../knowledge";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({
  requireDb: async () => {},
  requireUser: async () => ({ id: "user-1" }),
}));

const rememberMock = vi.fn();
vi.mock("@/lib/walrus", () => ({
  WalrusNotConfiguredError: class extends Error {},
  rememberPrivate: (...args: unknown[]) => rememberMock(...(args as [])),
}));

// In-memory Neon stand-in: workspace-scoped sources + chunks.
type Src = {
  id: string;
  workspace_id: string;
  type: string;
  title: string;
  source_url: string | null;
  canonical_content: string;
  status: string;
  created_at: string;
  updated_at: string;
};
type Chk = {
  id: string;
  knowledge_id: string;
  workspace_id: string;
  content: string;
  position: number;
  walrus_blob_id: string | null;
  created_at: string;
};
const store = { sources: [] as Src[], chunks: [] as Chk[], seq: 0 };
const nid = (p: string) => `${p}-${++store.seq}`;

vi.mock("@/lib/db", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getOwnedWorkspace: async (userId: string, slug: string) =>
      slug === "acme" ? { id: "ws-1", slug, owner_id: userId } : null,
    listKnowledgeSources: async (workspaceId: string) =>
      store.sources.filter((s) => s.workspace_id === workspaceId),
    getKnowledgeSource: async (id: string, workspaceId: string) =>
      store.sources.find((s) => s.id === id && s.workspace_id === workspaceId) ?? null,
    createKnowledgeSource: async (input: {
      workspaceId: string;
      type: string;
      title: string;
      sourceUrl: string | null;
      canonicalContent: string;
    }) => {
      const row: Src = {
        id: nid("src"),
        workspace_id: input.workspaceId,
        type: input.type,
        title: input.title,
        source_url: input.sourceUrl,
        canonical_content: input.canonicalContent,
        status: "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      store.sources.push(row);
      return row;
    },
    updateKnowledgeSource: async (id: string, workspaceId: string, patch: Record<string, string>) => {
      const row = store.sources.find((s) => s.id === id && s.workspace_id === workspaceId) ?? null;
      if (!row) return null;
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.canonicalContent !== undefined) row.canonical_content = patch.canonicalContent;
      if (patch.status !== undefined) row.status = patch.status;
      return row;
    },
    listKnowledgeChunks: async (knowledgeId: string, workspaceId: string) =>
      store.chunks
        .filter((c) => c.knowledge_id === knowledgeId && c.workspace_id === workspaceId)
        .sort((a, b) => a.position - b.position),
    saveKnowledgeChunk: async (input: {
      knowledgeId: string;
      workspaceId: string;
      content: string;
      position: number;
      blobId: string | null;
    }) => {
      store.chunks = store.chunks.filter(
        (c) => !(c.knowledge_id === input.knowledgeId && c.position === input.position),
      );
      store.chunks.push({
        id: nid("chk"),
        knowledge_id: input.knowledgeId,
        workspace_id: input.workspaceId,
        content: input.content,
        position: input.position,
        walrus_blob_id: input.blobId,
        created_at: new Date().toISOString(),
      });
    },
  };
});

const longManual = Array.from(
  { length: 120 },
  (_, i) => `NovaCart guide section ${i}: returns are accepted within thirty days with a receipt. Exchanges ship free both ways.`,
).join(" ");

function memDeps(over: Partial<IndexDeps> = {}): IndexDeps & { saved: { position: number }[]; statuses: string[] } {
  const saved: { position: number }[] = [];
  const statuses: string[] = [];
  return {
    saved,
    statuses,
    listChunks: async () => saved.map((s) => ({ position: s.position, walrus_blob_id: `blob-${s.position}` })),
    saveChunk: async (c) => {
      saved.push({ position: c.position });
    },
    setStatus: async (s) => {
      statuses.push(s);
    },
    remember: async (text: string) => `blob-${text.length}`,
    ...over,
  };
}

describe("indexNextBatch (bounded + resumable)", () => {
  it("multi-chunk documents index a few chunks per call and never claim ready early", async () => {
    const total = chunkText(longManual).slice(0, 20).length;
    expect(total).toBeGreaterThan(3);
    const d = memDeps();
    const first = await indexNextBatch(longManual, d);
    expect(first.status).toBe("pending");
    expect(first.chunksDone).toBeLessThanOrEqual(3);
    expect(first.chunksTotal).toBe(total);
    expect(d.statuses).not.toContain("ready");
  });

  it("slow Walrus still completes across bounded calls, then ready", async () => {
    const total = chunkText(longManual).slice(0, 20).length;
    const d = memDeps({
      remember: async (text: string) => {
        await new Promise((r) => setTimeout(r, 30));
        return `blob-${text.length}`;
      },
    });
    let last = await indexNextBatch(longManual, d);
    let calls = 1;
    while (last.status === "pending" && calls < 20) {
      last = await indexNextBatch(longManual, d);
      calls++;
    }
    expect(last.status).toBe("ready");
    expect(last.chunksDone).toBe(total);
    expect(d.statuses[d.statuses.length - 1]).toBe("ready");
  });

  it("Walrus failure marks failed; retry resumes only unfinished chunks", async () => {
    const seen: string[] = [];
    const d = memDeps({
      remember: async (text: string) => {
        seen.push(text);
        if (seen.length === 2) throw new Error("walrus overloaded");
        return `blob-${seen.length}`;
      },
    });
    const failed = await indexNextBatch(longManual, d);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("walrus overloaded");
    expect(d.statuses).toContain("failed");
    const doneBefore = d.saved.length;
    expect(doneBefore).toBe(1);
    // Retry with a healthy backend: skips chunk 0, finishes the rest.
    const d2 = memDeps({
      listChunks: d.listChunks,
      saveChunk: d.saveChunk,
      setStatus: d.setStatus,
      remember: async () => "blob-ok",
    });
    let last = await indexNextBatch(longManual, d2);
    let calls = 1;
    while (last.status === "pending" && calls < 20) {
      last = await indexNextBatch(longManual, d2);
      calls++;
    }
    expect(last.status).toBe("ready");
    // Chunk 0 indexed exactly once (no duplicate Walrus write for it).
    expect(seen).toHaveLength(2); // resume never re-wrote chunk 0 to Walrus
    expect(d.saved.filter((s) => s.position === 0)).toHaveLength(1);
  });

  it("empty canonical resolves ready without any Walrus call", async () => {
    const d = memDeps();
    const r = await indexNextBatch("   ", d);
    expect(r).toMatchObject({ status: "ready", chunksDone: 0, chunksTotal: 0 });
  });
});

describe("knowledge routes (persist-fast + bounded index)", () => {
  beforeEach(() => {
    store.sources = [];
    store.chunks = [];
    store.seq = 0;
    rememberMock.mockReset();
    rememberMock.mockImplementation(async () => ({ blobId: `blob-${Math.random().toString(36).slice(2)}` }));
  });

  const postKnowledge = async (body: unknown) => {
    const { POST } = await import("@/app/api/workspaces/[slug]/knowledge/route");
    return POST(
      new Request("http://x/api", { method: "POST", body: JSON.stringify(body) }),
      { params: Promise.resolve({ slug: "acme" }) },
    );
  };
  const postIndex = async (id: string) => {
    const { POST } = await import("@/app/api/workspaces/[slug]/knowledge/[id]/index/route");
    return POST(new Request("http://x/api", { method: "POST" }), {
      params: Promise.resolve({ slug: "acme", id }),
    });
  };

  it("manual knowledge persists durably without any Walrus wait", async () => {
    const res = await postKnowledge({ type: "manual", title: "Guide", content: longManual });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.source.status).toBe("pending");
    expect(data.source.chunksTotal).toBe(chunkText(longManual).slice(0, 20).length);
    expect(rememberMock).not.toHaveBeenCalled();
    expect(store.sources).toHaveLength(1);
  });

  it("retry/double-click reconciles to the same source (no duplicates)", async () => {
    const payload = { type: "manual", title: "Guide", content: longManual };
    const first = await (await postKnowledge(payload)).json();
    const second = await (await postKnowledge(payload)).json();
    expect(second.resumed).toBe(true);
    expect(second.source.id).toBe(first.source.id);
    expect(store.sources).toHaveLength(1);
    const viaId = await (
      await postKnowledge({ ...payload, sourceId: first.source.id })
    ).json();
    expect(viaId.source.id).toBe(first.source.id);
    expect(store.sources).toHaveLength(1);
  });

  it("pending -> ready across bounded index calls under a request budget", async () => {
    const { source } = await (await postKnowledge({ type: "manual", title: "Guide", content: longManual })).json();
    const seen: number[] = [];
    let firstStatus = "";
    for (let i = 0; i < 12; i++) {
      const r = await postIndex(source.id);
      const d = await r.json();
      firstStatus = firstStatus || d.status;
      seen.push(d.chunksDone);
      if (d.status === "ready") break;
    }
    expect(firstStatus).toBe("pending");
    expect(seen[0]).toBeLessThanOrEqual(3);
    const row = store.sources.find((s) => s.id === source.id)!;
    expect(row.status).toBe("ready");
    expect(store.chunks.filter((c) => c.knowledge_id === source.id)).toHaveLength(
      chunkText(longManual).slice(0, 20).length,
    );
  });

  it("pending -> failed -> retry resumes to ready", async () => {
    const { source } = await (await postKnowledge({ type: "manual", title: "Guide", content: longManual })).json();
    rememberMock.mockRejectedValueOnce(new Error("walrus overloaded"));
    const bad = await (await postIndex(source.id)).json();
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("walrus overloaded");
    expect(store.sources.find((s) => s.id === source.id)!.status).toBe("failed");
    rememberMock.mockImplementation(async () => ({ blobId: "blob-retry" }));
    let last = { status: "pending" };
    for (let i = 0; i < 12 && last.status === "pending"; i++) {
      last = await (await postIndex(source.id)).json();
    }
    expect(last.status).toBe("ready");
  });

  it("cross-workspace source ids never leak (404, no reads)", async () => {
    const { POST } = await import("@/app/api/workspaces/[slug]/knowledge/[id]/index/route");
    const res = await POST(new Request("http://x/api", { method: "POST" }), {
      params: Promise.resolve({ slug: "other-ws", id: "src-9" }),
    });
    expect(res.status).toBe(404);
    expect(rememberMock).not.toHaveBeenCalled();
  });

  it("edit (PATCH) persists fast as pending without Walrus", async () => {
    const { source } = await (await postKnowledge({ type: "manual", title: "Guide", content: longManual })).json();
    const { PATCH } = await import("@/app/api/workspaces/[slug]/knowledge/route");
    const res = await PATCH(
      new Request("http://x/api", { method: "PATCH", body: JSON.stringify({ id: source.id, content: `${longManual} Updated appendix.` }) }),
      { params: Promise.resolve({ slug: "acme" }) },
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.source.status).toBe("pending");
    expect(rememberMock).not.toHaveBeenCalled();
  });
});
