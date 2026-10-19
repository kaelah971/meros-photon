"use client";

import { useCallback, useEffect, useState } from "react";

type Source = {
  id: string;
  type: string;
  title: string;
  sourceUrl: string | null;
  status: string;
  updatedAt: string;
  contentChars: number;
};

const inputCls =
  "mt-1 w-full rounded-md border border-[rgba(119,255,117,0.25)] bg-[rgba(10,27,18,0.72)] px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[#77FF75]";
const labelCls = "block text-xs text-neutral-400";
const btnPrimary =
  "rounded-md bg-[#77FF75] px-4 py-2 text-xs font-medium text-neutral-950 disabled:opacity-40 hover:bg-emerald-400";
const btnGhost =
  "rounded-md border border-[rgba(119,255,117,0.25)] px-3 py-1.5 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)] disabled:opacity-40";

const TYPE_BLURB: Record<string, string> = {
  manual: "Hand-written product notes.",
  website: "Imported public website pages.",
  documentation: "Imported docs / help-center pages.",
  faq: "Frequently asked questions.",
  policy: "Support policies and guardrails.",
};

/** Owner knowledge manager: profile is read-only here (edited at creation
 *  time); sources support add / edit / re-import / delete. Statuses are
 *  honest server states: pending → ready | failed. */
export function KnowledgeManager({ workspaceSlug }: { workspaceSlug: string }) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [kind, setKind] = useState<"manual" | "url">("manual");
  const [ktype, setKtype] = useState("manual");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [url, setUrl] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [indexNote, setIndexNote] = useState<string | null>(null);
  const [retryId, setRetryId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceSlug}/knowledge`);
      const data = await res.json();
      if (data.ok) setSources(data.sources);
      else setError(data.error ?? "Could not load knowledge.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Drive a pending source to ready/failed with visible progress. The
  // save itself already returned fast; this never blocks the list.
  async function trackIndexing(id: string) {
    const { pollKnowledgeIndex } = await import("./knowledge-index-client");
    setRetryId(null);
    setIndexNote("Knowledge saved. Preparing search…");
    try {
      const done = await pollKnowledgeIndex(workspaceSlug, id, {
        onProgress: (p) => {
          if (p.status === "pending" && p.chunksTotal > 0) {
            setIndexNote(`Knowledge saved. Preparing search… (${p.chunksDone}/${p.chunksTotal})`);
          }
        },
      });
      if (done.status === "ready") {
        setIndexNote("Knowledge ready.");
      } else if (done.status === "failed") {
        setIndexNote(null);
        setRetryId(id);
        setError(`Search indexing failed: ${done.error ?? "unknown error"}. Your text is saved — retry to resume.`);
      } else {
        setIndexNote(null);
        setRetryId(id);
        setError("Search indexing is still working. Retry to resume where it stopped — your text is saved.");
      }
    } catch (e) {
      setIndexNote(null);
      setRetryId(id);
      setError(`Indexing interrupted: ${e instanceof Error ? e.message : "network error"}. Your text is saved — retry to resume.`);
    }
    await load();
  }

  async function create() {
    setError("");
    setBusy(true);
    try {
      const payload =
        kind === "manual"
          ? { type: ktype, title: title || undefined, content }
          : { type: "website", title: title || undefined, url };
      const res = await fetch(`/api/workspaces/${workspaceSlug}/knowledge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Could not save knowledge.");
        return;
      }
      // A resumed in-flight save returns the existing source — never a duplicate.
      const savedId = data.source?.id as string | undefined;
      const savedStatus = data.source?.status as string | undefined;
      setTitle("");
      setContent("");
      setUrl("");
      setShowAdd(false);
      await load();
      if (savedId && savedStatus === "pending") await trackIndexing(savedId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: string) {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceSlug}/knowledge`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, title: editTitle || undefined, content: editContent || undefined }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error ?? "Could not update knowledge.");
        return;
      }
      setEditingId(null);
      await load();
      if (data.source?.status === "pending" && typeof data.source?.id === "string") {
        await trackIndexing(data.source.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this knowledge source? Its index entries stop being used.")) return;
    setError("");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceSlug}/knowledge?id=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!data.ok) setError(data.error ?? "Could not delete.");
      else await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    }
  }

  return (
    <div>
      <p className="text-sm font-medium text-neutral-100">Product knowledge</p>
      <p className="mt-1 text-xs leading-5 text-neutral-400">
        Teach Meros what customers need to know about your product. Canonical
        text lives here in Neon; Walrus holds only the semantic index.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-300">
          {error}{" "}
          {retryId && (
            <button onClick={() => void trackIndexing(retryId)} className="underline hover:text-red-200">
              Retry indexing
            </button>
          )}
        </p>
      )}
      {indexNote && <p className="mt-2 text-xs text-neutral-400">{indexNote}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={() => setShowAdd((v) => !v)} className="rounded-md bg-[#77FF75] px-4 py-2 text-xs font-medium text-neutral-950 hover:bg-emerald-400">
          {showAdd ? "Close" : "+ Add knowledge"}
        </button>
      </div>

      {showAdd && (
        <div className="mt-3 space-y-3 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] p-4">
          <div className="flex gap-1 rounded-md border border-neutral-800 bg-neutral-950 p-1 text-xs">
            {(["manual", "url"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={`flex-1 rounded px-3 py-1.5 font-medium ${
                  kind === k ? "bg-[rgba(119,255,117,0.12)] text-[#9AFF8D]" : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {k === "manual" ? "Manual / FAQ / Policy" : "Website / Docs URL"}
              </button>
            ))}
          </div>
          {kind === "manual" ? (
            <>
              <div className="flex flex-wrap gap-2">
                <label className="text-xs text-neutral-400">
                  Type
                  <select value={ktype} onChange={(e) => setKtype(e.target.value)} className="mt-1 rounded-md border border-[rgba(119,255,117,0.25)] bg-[rgba(10,27,18,0.72)] px-2 py-2 text-xs text-neutral-200">
                    {["manual", "faq", "policy"].map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label className="flex-1 text-xs text-neutral-400">
                  Title
                  <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Product overview" className={inputCls} />
                </label>
              </div>
              <label className={labelCls}>
                Knowledge text (min 20 characters)
                <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} className={`${inputCls} resize-y font-mono text-[13px]`} />
              </label>
            </>
          ) : (
            <>
              <label className={labelCls}>
                Title (optional)
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Help center" className={inputCls} />
              </label>
              <label className={labelCls}>
                Public URL (http/https pages only — login walls fail honestly)
                <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.example.com" inputMode="url" autoCapitalize="none" spellCheck={false} className={`${inputCls} font-mono`} />
              </label>
            </>
          )}
          <button onClick={() => void create()} disabled={busy} className={btnPrimary}>
            {busy ? "Saving…" : "Save knowledge"}
          </button>
        </div>
      )}

      <h2 className="mt-6 text-sm font-medium text-neutral-100">Sources</h2>
      {sources === null ? (
        <p className="mt-2 text-xs text-neutral-500">Loading…</p>
      ) : sources.length === 0 ? (
        <p className="mt-2 rounded-md border border-neutral-800 bg-neutral-900 px-4 py-3 text-xs text-neutral-400">
          No knowledge yet. Add manual notes above — Meros answers better with product context.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {sources.map((s) => (
            <li key={s.id} className="rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-neutral-100">{s.title}</p>
                  <p className="mt-0.5 font-mono text-[11px] text-neutral-500">
                    {s.type} · {TYPE_BLURB[s.type] ?? ""} {s.status}
                    {s.sourceUrl ? ` · ${s.sourceUrl.slice(0, 60)}` : ""} · {s.contentChars} chars ·{" "}
                    {new Date(s.updatedAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  {s.type !== "website" && s.type !== "documentation" && (
                    <button
                      onClick={() => {
                        setEditingId(editingId === s.id ? null : s.id);
                        setEditTitle(s.title);
                        setEditContent("");
                      }}
                      className={btnGhost}
                    >
                      {editingId === s.id ? "Cancel" : "Edit"}
                    </button>
                  )}
                  <button onClick={() => void remove(s.id)} className={btnGhost}>
                    Delete
                  </button>
                </div>
              </div>
              {editingId === s.id && (
                <div className="mt-2 space-y-2 border-t border-neutral-800 pt-2">
                  <label className={labelCls}>
                    Title
                    <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className={inputCls} />
                  </label>
                  <label className={labelCls}>
                    New canonical text (replaces + re-indexes)
                    <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={5} className={`${inputCls} resize-y font-mono text-[13px]`} />
                  </label>
                  <button onClick={() => void saveEdit(s.id)} disabled={busy} className={btnPrimary}>
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
