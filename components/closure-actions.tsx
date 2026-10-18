"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Phase = { name: "idle" } | { name: "working"; label: string } | { name: "failed"; message: string } | { name: "confirm"; label: string };

/**
 * S12 closure review actions. Confirming closure needs an explicit second
 * click; administrative closures additionally need a typed reason. Nothing
 * here auto-closes or invents evidence.
 */
export default function ClosureActions({
  workspaceSlug,
  incidentId,
  draftId,
  eligible,
}: {
  workspaceSlug: string;
  incidentId: string;
  draftId: string | null;
  eligible: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [armed, setArmed] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [adminReason, setAdminReason] = useState("");

  async function post(url: string, body: Record<string, unknown>, label: string) {
    if (phase.name === "working") return;
    setPhase({ name: "working", label });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug, ...body }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setPhase({ name: "idle" });
        setArmed(null);
        router.refresh();
        return;
      }
      setPhase({ name: "failed", message: data.error ?? `request failed (${res.status})` });
    } catch (e) {
      setPhase({ name: "failed", message: e instanceof Error ? e.message : "request failed" });
    }
  }

  function ask(key: string, label: string): boolean {
    if (armed === key) {
      setArmed(null);
      return true;
    }
    setArmed(key);
    setPhase({ name: "confirm", label });
    return false;
  }

  const draft = () => post(`/api/incidents/${incidentId}/postmortems`, {}, "Assembling…");

  const close = () => {
    if (!draftId) {
      setPhase({ name: "failed", message: "Generate a current postmortem draft first." });
      return;
    }
    if (!ask("close", "Click again to confirm CLOSURE — incident will resolve")) return;
    post(`/api/incidents/${incidentId}/closure`, { postmortemId: draftId, note: note.trim() || undefined }, "Closing…");
  };

  const closeAdmin = () => {
    if (!adminReason.trim()) {
      setPhase({ name: "failed", message: "Administrative closure needs a reason." });
      return;
    }
    if (!ask("admin", "Click again to confirm ADMINISTRATIVE closure (not verified recovery)")) return;
    post(`/api/incidents/${incidentId}/closure`, { administrative: true, reason: adminReason.trim() }, "Closing…");
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={draft}
        disabled={phase.name === "working"}
        className="rounded-md border border-[rgba(255,255,255,0.2)] px-2.5 py-1 text-[11px] text-neutral-200 hover:bg-[rgba(255,255,255,0.06)] disabled:cursor-wait disabled:opacity-60"
      >
        {draftId ? "Refresh draft" : "Generate draft"}
      </button>
      {eligible && draftId && (
        <>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="closure note (optional)"
            className="w-44 rounded-md border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
          />
          <button
            type="button"
            onClick={close}
            disabled={phase.name === "working"}
            className="rounded-md border border-[rgba(119,255,117,0.3)] px-2.5 py-1 text-[11px] text-[#9AFF8D] hover:bg-[rgba(119,255,117,0.08)] disabled:cursor-wait disabled:opacity-60"
          >
            {armed === "close" ? "Confirm closure" : "Confirm closure"}
          </button>
        </>
      )}
      <input
        value={adminReason}
        onChange={(e) => setAdminReason(e.target.value)}
        placeholder="admin reason (exceptional only)"
        className="w-52 rounded-md border border-[rgba(255,255,255,0.15)] bg-black/30 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600"
      />
      <button
        type="button"
        onClick={closeAdmin}
        disabled={phase.name === "working"}
        className="rounded-md border border-[rgba(255,180,120,0.4)] px-2.5 py-1 text-[11px] text-amber-200 hover:bg-[rgba(255,180,120,0.06)] disabled:cursor-wait disabled:opacity-60"
      >
        {armed === "admin" ? "Confirm admin closure" : "Administrative closure"}
      </button>
      {phase.name === "failed" && <span className="text-[11px] text-red-300">{phase.message}</span>}
      {phase.name === "confirm" && <span className="text-[11px] text-amber-200">{phase.label}</span>}
      {phase.name === "working" && <span className="text-[11px] text-neutral-400">{phase.label}</span>}
    </span>
  );
}
