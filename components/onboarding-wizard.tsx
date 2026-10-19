"use client";

import Link from "next/link";
import { useState } from "react";

type OrgResult = { id: string; slug: string; name: string };
type WsResult = { slug: string; name: string; supportUrl: string };

const inputCls =
  "mt-1 w-full rounded-md border border-[rgba(119,255,117,0.25)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-[#77FF75]";
const labelCls = "block text-xs text-neutral-400";
const btnPrimary =
  "rounded-md bg-[#77FF75] px-5 py-2.5 text-sm font-medium text-neutral-950 disabled:opacity-40 hover:bg-emerald-400";
const btnGhost =
  "rounded-md border border-[rgba(119,255,117,0.25)] px-4 py-2 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)] disabled:opacity-40";

/**
 * Owner onboarding wizard: organization → workspace → product knowledge →
 * ready. Every step persists to Neon immediately (no lost progress on
 * refresh); knowledge/URL steps are optional and URL failure never blocks.
 */
export function OnboardingWizard() {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [orgName, setOrgName] = useState("");
  const [orgDesc, setOrgDesc] = useState("");
  const [org, setOrg] = useState<OrgResult | null>(null);

  const [wsName, setWsName] = useState("");
  const [wsSlug, setWsSlug] = useState("");
  const [productName, setProductName] = useState("");
  const [productDesc, setProductDesc] = useState("");
  const [supportCtx, setSupportCtx] = useState("");
  const [ws, setWs] = useState<WsResult | null>(null);

  const [manualTitle, setManualTitle] = useState("Product overview");
  const [manualType, setManualType] = useState("manual");
  const [manualText, setManualText] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [docsUrl, setDocsUrl] = useState("");
  const [knowledgeNote, setKnowledgeNote] = useState<string | null>(null);
  const [failedJobs, setFailedJobs] = useState<string[]>([]);

  // Bounded save: the server persists knowledge fast, but the request
  // itself must never hang the UI — a timeout surfaces as a resumable
  // error (the server reconciles identical retries, never duplicates).
  async function postJson(url: string, body: unknown, timeoutMs = 30_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      return { status: res.status, data: await res.json() };
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error("Request timed out — your save may have completed. Retry to resume it (no duplicates)." );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // Background indexing for saved sources: step 04 stays reachable while
  // pending; progress lands in the status line; failures offer a retry.
  async function trackIndexing(slug: string, ids: string[]) {
    const { pollKnowledgeIndex } = await import("./knowledge-index-client");
    const failed: string[] = [];
    for (const id of ids) {
      try {
        const done = await pollKnowledgeIndex(slug, id, {
          onProgress: (p) => {
            if (p.status === "pending" && p.chunksTotal > 0) {
              setKnowledgeNote(`Knowledge saved. Preparing search… (${p.chunksDone}/${p.chunksTotal})`);
            }
          },
        });
        if (done.status !== "ready") failed.push(id);
      } catch {
        failed.push(id);
      }
    }
    setFailedJobs(failed);
    if (failed.length === 0) {
      setKnowledgeNote((n) =>
        n && n.startsWith("Knowledge saved") ? "Knowledge ready." : n,
      );
    } else {
      setError("Search indexing needs another moment — your text is saved. Retry to resume.");
    }
  }

  async function createOrg() {
    setError("");
    setBusy(true);
    try {
      const { data } = await postJson("/api/organizations", {
        name: orgName,
        description: orgDesc || undefined,
      });
      if (!data.ok) {
        setError(data.error ?? "Could not create organization.");
        return;
      }
      setOrg(data.organization);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace() {
    if (!org) return;
    setError("");
    setBusy(true);
    try {
      const { status, data } = await postJson("/api/workspaces", {
        organizationId: org.id,
        name: wsName,
        slug: wsSlug || undefined,
        productName: productName || undefined,
        productDescription: productDesc || undefined,
        supportContext: supportCtx || undefined,
      });
      if (!data.ok) {
        setError(
          status === 409
            ? "That workspace URL is taken — try another slug."
            : (data.error ?? "Could not create workspace."),
        );
        return;
      }
      setWs(data.workspace);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  async function saveKnowledge(kind: "manual" | "url", url?: string, typeOverride?: string) {
    if (!ws) return null;
    const payload =
      kind === "manual"
        ? { type: typeOverride ?? manualType, title: manualTitle, content: manualText }
        : { type: "website", url };
    const { data } = await postJson(`/api/workspaces/${ws.slug}/knowledge`, payload);
    return data as { ok: boolean; error?: string; resumed?: boolean; source?: { id: string; status: string; chunksTotal?: number } };
  }

  async function submitKnowledge() {
    if (!ws) return;
    setError("");
    setFailedJobs([]);
    setBusy(true);
    const ids: string[] = [];
    const notes: string[] = [];
    try {
      if (manualText.trim().length >= 20) {
        const r = await saveKnowledge("manual");
        if (r?.ok && r.source) {
          ids.push(r.source.id);
          notes.push("Manual knowledge saved.");
        } else {
          notes.push(`Manual knowledge failed: ${r?.error ?? "unknown"}.`);
        }
      }
      for (const u of [siteUrl, docsUrl].map((s) => s.trim()).filter(Boolean)) {
        const r = await saveKnowledge("url", u);
        if (r?.ok && r.source) {
          ids.push(r.source.id);
          notes.push(`Imported ${u}.`);
        } else {
          notes.push(`Import failed for ${u}: ${r?.error ?? "unknown"}.`);
        }
      }
      if (notes.length === 0) notes.push("Skipped — you can add knowledge later from the console.");
      // Step 04 is reachable immediately: saves are durable, indexing
      // continues in the background and never blocks navigation.
      setKnowledgeNote(ids.length > 0 ? "Knowledge saved. Preparing search…" : notes.join(" "));
      setStep(4);
      if (ids.length > 0) void trackIndexing(ws.slug, ids);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  const steps = ["Organization", "Workspace", "Knowledge", "Ready"];

  return (
    <div>
      <ol className="flex flex-wrap gap-2" aria-label="Onboarding progress">
        {steps.map((label, i) => {
          const n = i + 1;
          const active = n === step;
          const done = n < step;
          return (
            <li
              key={label}
              aria-current={active ? "step" : undefined}
              className={`rounded-md border px-3 py-1.5 font-mono text-[11px] ${
                active
                  ? "border-[rgba(119,255,117,0.5)] text-[#9AFF8D]"
                  : done
                    ? "border-[rgba(119,255,117,0.25)] text-[#4CA862]"
                    : "border-neutral-800 text-neutral-500"
              }`}
            >
              0{n} {label}
            </li>
          );
        })}
      </ol>

      {error && (
        <p role="alert" className="mt-4 text-xs text-red-300">
          {error}
        </p>
      )}

      {step === 1 && (
        <section className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] p-4">
          <h2 className="text-sm font-medium text-neutral-100">01 · Organization</h2>
          <div className="mt-3 space-y-3">
            <label className={labelCls}>
              Organization name
              <input value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="e.g. Acme Inc" autoComplete="off" className={inputCls} />
            </label>
            <label className={labelCls}>
              Short company description (optional)
              <textarea
                value={orgDesc}
                onChange={(e) => setOrgDesc(e.target.value)}
                placeholder="What does your company do?"
                rows={2}
                className={`${inputCls} resize-y`}
              />
            </label>
            <button onClick={() => void createOrg()} disabled={busy || orgName.trim().length < 2} className={btnPrimary}>
              {busy ? "Creating…" : "Create organization →"}
            </button>
          </div>
        </section>
      )}

      {step === 2 && org && (
        <section className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] p-4">
          <h2 className="text-sm font-medium text-neutral-100">02 · Product workspace</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Organization <span className="text-neutral-200">{org.name}</span> created.
          </p>
          <div className="mt-3 space-y-3">
            <label className={labelCls}>
              Workspace name
              <input value={wsName} onChange={(e) => setWsName(e.target.value)} placeholder="e.g. Acme Support" autoComplete="off" className={inputCls} />
            </label>
            <label className={labelCls}>
              Workspace slug (URL-safe, unique)
              <input value={wsSlug} onChange={(e) => setWsSlug(e.target.value)} placeholder="e.g. acme (optional — derived from name)" autoComplete="off" autoCapitalize="none" spellCheck={false} className={`${inputCls} font-mono`} />
            </label>
            <label className={labelCls}>
              Product name
              <input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="e.g. Acme Product" autoComplete="off" className={inputCls} />
            </label>
            <label className={labelCls}>
              Product description (optional)
              <textarea value={productDesc} onChange={(e) => setProductDesc(e.target.value)} placeholder="What is the product?" rows={2} className={`${inputCls} resize-y`} />
            </label>
            <label className={labelCls}>
              Support context (optional)
              <textarea
                value={supportCtx}
                onChange={(e) => setSupportCtx(e.target.value)}
                placeholder="Anything support should always know (versions, constraints, links…)"
                rows={2}
                className={`${inputCls} resize-y`}
              />
            </label>
            <button onClick={() => void createWorkspace()} disabled={busy || wsName.trim().length < 2} className={btnPrimary}>
              {busy ? "Creating…" : "Create workspace →"}
            </button>
          </div>
        </section>
      )}

      {step === 3 && ws && (
        <section className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] p-4">
          <h2 className="text-sm font-medium text-neutral-100">03 · Product knowledge (optional)</h2>
          <p className="mt-1 text-xs text-neutral-400">
            Teach Meros what customers need to know. Manual notes, a website, or docs —
            or skip and add later. URL imports that fail never block you.
          </p>
          <div className="mt-3 space-y-3">
            <div className="flex gap-2">
              <label className={`${labelCls} flex-1`}>
                Manual knowledge
                <textarea
                  value={manualText}
                  onChange={(e) => setManualText(e.target.value)}
                  placeholder="Product overview, features, workflows, policies, limitations, FAQs… (min 20 chars)"
                  rows={5}
                  className={`${inputCls} resize-y font-mono text-[13px]`}
                />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="text-xs text-neutral-400">
                Type
                <select
                  value={manualType}
                  onChange={(e) => setManualType(e.target.value)}
                  className="mt-1 rounded-md border border-[rgba(119,255,117,0.25)] bg-[rgba(10,27,18,0.72)] px-2 py-2 text-xs text-neutral-200"
                >
                  {["manual", "faq", "policy"].map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="flex-1 text-xs text-neutral-400">
                Title
                <input value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} className={inputCls} />
              </label>
            </div>
            <label className={labelCls}>
              Website / app URL (optional, public pages only)
              <input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://example.com" inputMode="url" autoCapitalize="none" spellCheck={false} className={`${inputCls} font-mono`} />
            </label>
            <label className={labelCls}>
              Docs / help-center URL (optional)
              <input value={docsUrl} onChange={(e) => setDocsUrl(e.target.value)} placeholder="https://docs.example.com" inputMode="url" autoCapitalize="none" spellCheck={false} className={`${inputCls} font-mono`} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => void submitKnowledge()} disabled={busy} className={btnPrimary}>
                {busy ? "Saving…" : "Save and continue →"}
              </button>
              <button
                onClick={() => {
                  setKnowledgeNote("Skipped — you can add knowledge later from the console.");
                  setStep(4);
                }}
                disabled={busy}
                className={btnGhost}
              >
                Skip for now
              </button>
            </div>
          </div>
        </section>
      )}

      {step === 4 && ws && (
        <section className="mt-4 rounded-md border border-[rgba(119,255,117,0.3)] bg-[rgba(10,27,18,0.72)] p-4">
          <h2 className="font-display text-sm font-bold tracking-[0.2em] text-[#9AFF8D]">04 · READY</h2>
          {knowledgeNote && <p className="mt-2 text-xs text-neutral-400">{knowledgeNote}</p>}
          {failedJobs.length > 0 && ws && (
            <button
              onClick={() => {
                setError("");
                setKnowledgeNote("Knowledge saved. Preparing search…");
                void trackIndexing(ws.slug, failedJobs);
              }}
              className="mt-2 rounded-md border border-[rgba(119,255,117,0.25)] px-4 py-2 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)]"
            >
              Retry search indexing
            </button>
          )}
          <p className="mt-2 text-xs text-neutral-400">Customer support URL</p>
          <code className="mt-1 block truncate rounded bg-[#06100B] px-2 py-2 font-mono text-[12px] text-[#9AFF8D]">
            /support/{ws.slug}
          </code>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/app/workspaces/${ws.slug}`}
              className="rounded-md bg-[#77FF75] px-4 py-2 text-xs font-medium text-neutral-950 hover:bg-emerald-400"
            >
              Open workspace
            </Link>
            <Link
              href={`/support/${ws.slug}`}
              className="rounded-md border border-[rgba(119,255,117,0.25)] px-4 py-2 text-xs text-neutral-300 hover:border-[rgba(119,255,117,0.5)]"
            >
              Open customer support
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
