"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type SendState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; deduped: boolean }
  | { phase: "failed"; message: string; stalePreview?: boolean };

/**
 * S7 explicit snapshot send: one deliberate click = one send attempt. Each
 * click mints a fresh client idempotency key, so an explicit second click is
 * a separate deliberate send while double-clicks, browser retries, and
 * concurrent requests with the SAME key dedupe server-side. The button
 * disables mid-flight. On a fingerprint mismatch (evidence changed since
 * preview), the fresh snapshot comes back in the response and the preview
 * reloads instead of sending stale text.
 */
export default function SnapshotSendButton({
  workspaceSlug,
  incidentId,
  expectedFingerprint,
  briefVersion,
}: {
  workspaceSlug: string;
  incidentId: string;
  expectedFingerprint: string;
  briefVersion: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<SendState>({ phase: "idle" });

  async function send() {
    if (state.phase === "sending") return;
    setState({ phase: "sending" });
    try {
      const res = await fetch(`/api/incidents/${incidentId}/snapshot/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceSlug,
          clientSnapshotId:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          expectedFingerprint,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        deduped?: boolean;
        code?: string;
        error?: string;
        snapshot?: { fingerprint?: string };
      };
      if (res.ok && data.ok) {
        setState({ phase: "sent", deduped: data.deduped === true });
        return;
      }
      const stale =
        data.code === "fingerprint_mismatch" || data.code === "brief_not_ready";
      setState({
        phase: "failed",
        message: data.error ?? `request failed (${res.status})`,
        stalePreview: stale,
      });
      if (stale) router.refresh();
    } catch (e) {
      setState({ phase: "failed", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={send}
        disabled={state.phase === "sending"}
        className="rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-wait disabled:opacity-60"
      >
        {state.phase === "sending"
          ? "Sending…"
          : `Send brief v${briefVersion} to my iMessage`}
      </button>
      {state.phase === "sent" && (
        <p className="mt-1.5 text-[11px] text-[#9AFF8D]">
          {state.deduped
            ? "Already sent for this action — no duplicate delivered."
            : "Sent — accepted by Photon (handset delivery not confirmed)."}
        </p>
      )}
      {state.phase === "failed" && (
        <p className="mt-1.5 text-[11px] text-red-300">
          Failed: {state.message}
          {state.stalePreview ? " Preview reloaded with the current version." : ""}
        </p>
      )}
    </div>
  );
}
