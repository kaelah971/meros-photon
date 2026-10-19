"use client";

import { useEffect, useRef, useState } from "react";
import {
  composeLink,
  formatCountdown,
  pairingMessage,
  pairingSecondsLeft,
  qrPayloadForPairing,
} from "@/lib/photon/pairing-link";

type Issued = { bindingId: string; code: string; expiresAt: string; contact: string | null };
type Phase = "idle" | "waiting" | "connected" | "expired" | "failed";

const POLL_MS = 5_000;
const POLL_MAX = 60;

/**
 * Connect-your-iPhone flow: one-time code, Messages compose link, local QR,
 * copy fallback, live countdown, and truthful connection status polled from
 * the staff-gated roster. The code lives only in component state — never
 * localStorage, logs, or persistent storage. "Connected" only ever reflects
 * an active DB binding, never a button press.
 */
export default function PhotonPairingManager({
  workspaceSlug,
  activeBinding,
}: {
  workspaceSlug: string;
  activeBinding: { id: string; lastSeenAt: string | null } | null;
}) {
  const [issued, setIssued] = useState<Issued | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const polls = useRef(0);

  const connected = Boolean(activeBinding) && !revoked;

  // Live countdown while a code is waiting.
  useEffect(() => {
    if (phase !== "waiting" || !issued) return;
    const tick = () => {
      const left = pairingSecondsLeft(issued.expiresAt);
      setSecondsLeft(left);
      if (left <= 0) {
        setPhase("expired");
        setIssued(null);
        setQrSrc(null);
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, issued]);

  // Truthful status: poll the staff-gated roster until this binding turns
  // active (connected), disappears/expires, or the budget runs out.
  useEffect(() => {
    if (phase !== "waiting" || !issued) return;
    polls.current = 0;
    let stop = false;
    const check = async () => {
      if (stop) return;
      polls.current++;
      try {
        const res = await fetch(
          `/api/photon/bindings?workspaceSlug=${encodeURIComponent(workspaceSlug)}`,
        );
        const data = (await res.json()) as {
          ok?: boolean;
          bindings?: { id: string; status: string }[];
        };
        const row = data.ok ? data.bindings?.find((b) => b.id === issued.bindingId) : undefined;
        if (row?.status === "active") {
          setPhase("connected");
          return;
        }
        if (!row && pairingSecondsLeft(issued.expiresAt) <= 0) {
          setPhase("expired");
          setIssued(null);
          return;
        }
      } catch {
        // Transient — keep waiting until the budget runs out.
      }
      if (polls.current >= POLL_MAX) {
        setPhase("failed");
        return;
      }
      setTimeout(check, POLL_MS);
    };
    const t = setTimeout(check, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, issued?.bindingId, workspaceSlug]);

  // Local QR (generated on-device, no external service sees the code).
  useEffect(() => {
    if (!qrOpen || !issued || phase !== "waiting") {
      setQrSrc(null);
      return;
    }
    let live = true;
    (async () => {
      try {
        const { default: QRCode } = await import("qrcode");
        const url = await QRCode.toDataURL(qrPayloadForPairing(issued.code, issued.contact), {
          width: 220,
          margin: 1,
        });
        if (live) setQrSrc(url);
      } catch {
        if (live) setQrSrc(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [qrOpen, issued, phase]);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    setQrOpen(false);
    setQrSrc(null);
    try {
      const res = await fetch("/api/photon/bindings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        bindingId?: string;
        code?: string;
        expiresAt?: string;
        contact?: string | null;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.code || !data.bindingId) {
        setError(data.error ?? `request failed (${res.status})`);
        setPhase("failed");
        return;
      }
      setIssued({
        bindingId: data.bindingId,
        code: data.code,
        expiresAt: data.expiresAt ?? "",
        contact: data.contact ?? null,
      });
      setPhase("waiting");
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
      setPhase("failed");
    } finally {
      setBusy(false);
    }
  }

  async function copyCommand() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(pairingMessage(issued.code));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function revoke() {
    const current = activeBinding;
    if (busy || !current || revoked) return;
    if (
      !window.confirm(
        "Disconnect this iPhone? Meros will stop replying and sending alerts to it. You can connect again with a fresh code.",
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
        body: JSON.stringify({ workspaceSlug, bindingId: current.id }),
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
      <p className="text-xs font-medium text-neutral-100">Connect your iPhone</p>
      <p className="mt-0.5 text-[11px] text-neutral-400">
        For support staff only — this links your iPhone to Meros, not customers.
      </p>

      {connected ? (
        <div className="mt-1.5">
          <p className="text-[11px] font-medium text-[#9AFF8D]">You&apos;re connected!</p>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-neutral-400">
              This iPhone receives Meros replies and alerts for this workspace
              {activeBinding?.lastSeenAt
                ? ` · last active ${new Date(activeBinding.lastSeenAt).toLocaleDateString()}`
                : ""}
              .
            </p>
            <button
              type="button"
              onClick={revoke}
              disabled={busy}
              className="rounded-md border border-[rgba(255,120,120,0.4)] px-3 py-1.5 text-xs text-red-200 hover:bg-[rgba(255,120,120,0.1)] disabled:cursor-wait disabled:opacity-60"
            >
              {busy ? "Working…" : "Disconnect"}
            </button>
          </div>
        </div>
      ) : revoked ? (
        <p className="mt-1.5 text-[11px] text-amber-200/90">
          Disconnected. Generate a fresh code below to connect again.
        </p>
      ) : phase === "connected" ? (
        <div className="mt-1.5">
          <p className="text-[11px] font-medium text-[#9AFF8D]">You&apos;re connected!</p>
          <p className="mt-0.5 text-[11px] text-neutral-400">
            Refresh this page to unlock proactive options for this workspace.
          </p>
        </div>
      ) : (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          No iPhone connected to your staff account in this workspace yet.
        </p>
      )}

      {!connected && phase !== "connected" && (
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="mt-2 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-wait disabled:opacity-60"
        >
          {busy ? "Working…" : issued ? "Generate a new code" : "Connect with Messages"}
        </button>
      )}

      {phase === "waiting" && issued && (
        <div className="mt-2 rounded bg-[#06100B] px-2 py-2">
          <p className="text-[11px] font-medium text-neutral-200">
            Waiting for your confirmation… code expires in {formatCountdown(secondsLeft)}
          </p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11px] text-neutral-400">
            <li>Open Messages on your iPhone (button, QR, or copy below).</li>
            <li>Review the pairing message and press Send — nothing sends automatically.</li>
            <li>Come back here; we confirm the moment Meros hears from you.</li>
          </ol>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <a
              href={composeLink(issued.code, issued.contact)}
              className="rounded-md bg-[#77FF75] px-3 py-1.5 text-[11px] font-medium text-[#030806] hover:bg-[#9AFF8D]"
            >
              Open Messages
            </a>
            <button
              type="button"
              onClick={() => setQrOpen((v) => !v)}
              className="rounded border border-[rgba(119,255,117,0.3)] px-2 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.1)]"
            >
              {qrOpen ? "Hide QR" : "Show QR (desktop)"}
            </button>
            <button
              type="button"
              onClick={copyCommand}
              className="rounded border border-[rgba(119,255,117,0.3)] px-2 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.1)]"
            >
              {copied ? "Copied" : "Copy message"}
            </button>
          </div>
          {!issued.contact && (
            <p className="mt-1.5 text-[11px] text-neutral-500">
              No verified contact is configured, so pick the Meros number yourself after Messages
              opens. Depending on the device it may arrive as SMS.
            </p>
          )}
          <p className="mt-1 font-mono text-[12px] text-[#9AFF8D]">{pairingMessage(issued.code)}</p>
          {qrOpen && (
            <div className="mt-2">
              {qrSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={qrSrc} alt="QR code opening the pairing message" width={220} height={220} />
              ) : (
                <p className="text-[11px] text-neutral-500">Preparing QR…</p>
              )}
              <p className="mt-1 text-[11px] text-neutral-500">
                Scanning only opens Messages — review and press Send.
              </p>
            </div>
          )}
        </div>
      )}

      {phase === "expired" && (
        <div className="mt-2">
          <p className="text-[11px] text-amber-200/90">
            Your connection code has expired. Generate another one to try again.
          </p>
          <button
            type="button"
            onClick={generate}
            disabled={busy}
            className="mt-1.5 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-wait disabled:opacity-60"
          >
            {busy ? "Working…" : "Generate a new code"}
          </button>
        </div>
      )}

      {phase === "failed" && (
        <div className="mt-2">
          <p className="text-[11px] text-red-300">
            {error ?? "Something went wrong. Check your connection and try again."}{" "}
            <button type="button" onClick={generate} className="underline hover:text-red-200">
              Try again
            </button>
          </p>
          <p className="mt-1 text-[11px] text-neutral-500">
            Troubleshooting: make sure you sent the message from the iPhone you want to connect,
            and that the code hadn&apos;t expired. Codes work once and last 15 minutes.
          </p>
        </div>
      )}
      {phase !== "failed" && error && (
        <p className="mt-1.5 text-[11px] text-red-300">Failed: {error}</p>
      )}
    </div>
  );
}
