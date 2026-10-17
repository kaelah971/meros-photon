"use client";

import { useState } from "react";

type Issued = { code: string; expiresAt: string };

/**
 * S3 pairing management: issue a one-time code via the EXISTING bindings API,
 * show it once with expiry + copyable `pair` command, and revoke the active
 * binding with explicit confirmation. Never stores codes; never logs them;
 * issuing never touches the currently active binding.
 */
export default function PhotonPairingManager({
  workspaceSlug,
  activeBinding,
}: {
  workspaceSlug: string;
  activeBinding: { id: string; lastSeenAt: string | null } | null;
}) {
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/photon/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug }),
      });
      const data = (await res.json()) as { ok?: boolean; code?: string; expiresAt?: string; error?: string };
      if (!res.ok || !data.ok || !data.code) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      // Shown once, kept only in this component's state — never persisted.
      setIssued({ code: data.code, expiresAt: data.expiresAt ?? "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(`pair ${issued.code}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function revoke() {
    if (busy || !activeBinding || revoked) return;
    if (
      !window.confirm(
        "Revoke this iMessage pairing? Proactive messages stop immediately. You can pair again with a fresh code.",
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/photon/bindings", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug, bindingId: activeBinding.id }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      setRevoked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 border-t border-[rgba(119,255,117,0.12)] pt-2.5">
      <p className="text-xs text-neutral-100">Pairing management</p>
      {activeBinding && !revoked ? (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-neutral-400">
            This sender is paired
            {activeBinding.lastSeenAt
              ? ` · active ${new Date(activeBinding.lastSeenAt).toLocaleDateString()}`
              : ""}
            .
          </p>
          <button
            type="button"
            onClick={revoke}
            disabled={busy}
            className="rounded-md border border-[rgba(255,120,120,0.4)] px-3 py-1.5 text-xs text-red-200 hover:bg-[rgba(255,120,120,0.1)] disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? "Working…" : "Revoke pairing"}
          </button>
        </div>
      ) : revoked ? (
        <p className="mt-1.5 text-[11px] text-amber-200/90">
          Pairing revoked. Generate a fresh code below to pair again.
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          No active pairing for your staff account in this workspace.
        </p>
      )}
      <button
        type="button"
        onClick={generate}
        disabled={busy}
        className="mt-2 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Working…" : issued ? "Generate a new code" : "Generate pairing code"}
      </button>
      {issued && (
        <div className="mt-2 rounded bg-[#06100B] px-2 py-2">
          <p className="text-[11px] text-neutral-400">
            Reply from iMessage within 15 minutes{issued.expiresAt ? ` (expires ${new Date(issued.expiresAt).toLocaleTimeString()})` : ""}:
          </p>
          <div className="mt-1 flex items-center gap-2">
            <code className="flex-1 truncate font-mono text-[12px] text-[#9AFF8D]">
              pair {issued.code}
            </code>
            <button
              type="button"
              onClick={copyCommand}
              className="shrink-0 rounded border border-[rgba(119,255,117,0.3)] px-2 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.1)]"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-1.5 text-[11px] text-red-300">Failed: {error}</p>}
    </div>
  );
}
