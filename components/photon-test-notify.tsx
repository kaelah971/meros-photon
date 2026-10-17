"use client";

import { useState } from "react";

type SendState =
  | { phase: "idle" }
  | { phase: "sending" }
  | { phase: "sent"; deduped: boolean }
  | { phase: "failed"; message: string };

/**
 * S2 operator connectivity test: explicit staff click only. Each click mints
 * a fresh client idempotency key, so an explicit second click is a separate
 * deliberate send while transport retries with the same key dedupe server-
 * side. The button disables mid-flight to prevent accidental double sends.
 */
export default function PhotonTestNotify({ workspaceSlug }: { workspaceSlug: string }) {
  const [state, setState] = useState<SendState>({ phase: "idle" });

  async function send() {
    if (state.phase === "sending") return;
    setState({ phase: "sending" });
    try {
      const res = await fetch("/api/photon/notify/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceSlug,
          clientNotificationId:
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        deduped?: boolean;
        code?: string;
        error?: string;
      };
      if (res.ok && data.ok) {
        setState({ phase: "sent", deduped: data.deduped === true });
      } else {
        setState({
          phase: "failed",
          message: data.error ?? `request failed (${res.status})`,
        });
      }
    } catch (e) {
      setState({ phase: "failed", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  return (
    <div className="mt-3 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <p className="text-xs text-neutral-100">Operator iMessage test</p>
      <p className="mt-0.5 text-[11px] text-neutral-400">
        Sends one connectivity message to your own paired iMessage. Explicit clicks only.
      </p>
      <button
        type="button"
        onClick={send}
        disabled={state.phase === "sending"}
        className="mt-2 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-wait disabled:opacity-60"
      >
        {state.phase === "sending" ? "Sending…" : "Send test notification"}
      </button>
      {state.phase === "sent" && (
        <p className="mt-1.5 text-[11px] text-[#9AFF8D]">
          {state.deduped
            ? "Already sent for this action — no duplicate delivered."
            : "Sent — accepted by Photon (handset delivery not confirmed)."}
        </p>
      )}
      {state.phase === "failed" && (
        <p className="mt-1.5 text-[11px] text-red-300">Failed: {state.message}</p>
      )}
    </div>
  );
}
