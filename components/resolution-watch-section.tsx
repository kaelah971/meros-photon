import { realPlanStore } from "@/lib/recovery-plans";
import { type WatchObservation, type WatchRow } from "@/lib/resolution-watch";
import { realWatchDeps, watchFreshness } from "@/lib/resolution-watch-store";
import ResolutionWatchActions from "@/components/resolution-watch-actions";

function statusLabel(s: WatchRow["status"]): { text: string; cls: string } {
  switch (s) {
    case "awaiting_evidence":
      return { text: "AWAITING EVIDENCE", cls: "text-neutral-300 border-[rgba(255,255,255,0.25)]" };
    case "watching":
      return { text: "WATCHING", cls: "text-neutral-200 border-[rgba(255,255,255,0.25)]" };
    case "improvement_indicated":
      return { text: "IMPROVEMENT INDICATED — not yet verified", cls: "text-[#9AFF8D] border-[rgba(119,255,117,0.4)]" };
    case "still_affected":
      return { text: "STILL AFFECTED", cls: "text-amber-200 border-[rgba(255,180,120,0.4)]" };
    case "insufficient_evidence":
      return { text: "INSUFFICIENT EVIDENCE", cls: "text-neutral-400 border-[rgba(255,255,255,0.2)]" };
    case "resolution_confirmed":
      return { text: "RESOLUTION CONFIRMED", cls: "text-[#9AFF8D] border-[rgba(119,255,117,0.5)]" };
  }
}

function kindLabel(k: WatchObservation["kind"]): string {
  switch (k) {
    case "customer_improvement":
      return "customer-reported improvement";
    case "customer_persistence":
      return "symptoms still reported";
    case "regression":
      return "REGRESSION after improvement";
    case "operator_note":
      return "operator note";
    case "verification":
      return "verification";
    case "system_note":
      return "system note";
  }
}

/**
 * S11 Resolution Watch: durable follow-up tracking for a recorded S10
 * intervention. Read-only when data is missing; never executes, sends,
 * or closes incidents. Degrades without breaking the incident page.
 */
export default async function ResolutionWatchSection({
  workspaceSlug,
  workspaceId,
  incidentId,
}: {
  workspaceSlug: string;
  workspaceId: string;
  incidentId: string;
}) {
  let watches: WatchRow[] = [];
  let obsByWatch = new Map<string, WatchObservation[]>();
  let stagedPlans: { id: string; version: number }[] = [];
  let freshByWatch = new Map<string, boolean>();
  try {
    const deps = await realWatchDeps({ judge: false });
    watches = await deps.watches.listForIncident(incidentId, workspaceId).catch(() => []);
    const pairs = await Promise.all(
      watches.slice(0, 5).map(async (w) => ({
        id: w.id,
        obs: await deps.observations.listForWatch(w.id, workspaceId).catch(() => []),
        fresh: (await watchFreshness(w, workspaceId).catch(() => ({ current: true }))).current,
      })),
    );
    for (const p of pairs) {
      obsByWatch.set(p.id, p.obs);
      freshByWatch.set(p.id, p.fresh);
    }
    try {
      const plans = await realPlanStore();
      const active = await plans.loadActive(incidentId, workspaceId).catch(() => []);
      stagedPlans = active.filter((p) => p.status === "staged").map((p) => ({ id: p.id, version: p.plan_version }));
    } catch {
      stagedPlans = [];
    }
  } catch {
    return (
      <div className="mt-4">
        <h2 className="text-xs font-medium text-neutral-100">Resolution Watch</h2>
        <p className="mt-1 text-[11px] text-neutral-500">
          Watch data unavailable right now (database unreachable). Incident data is unaffected.
        </p>
      </div>
    );
  }

  const current = watches.find((w) => w.status !== "resolution_confirmed") ?? null;
  const history = current ? watches.filter((w) => w.id !== current.id) : watches;

  return (
    <div className="mt-4 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-neutral-100">Resolution Watch</h2>
        <ResolutionWatchActions
          workspaceSlug={workspaceSlug}
          incidentId={incidentId}
          watchId={current?.id ?? null}
          watchStatus={current?.status ?? null}
          stagedPlans={stagedPlans}
        />
      </div>

      {!current && history.length === 0 && (
        <p className="mt-1.5 text-[11px] text-neutral-400">
          {stagedPlans.length > 0
            ? "No watch yet. Start one to monitor real follow-up evidence after the recorded intervention — a verified action is not automatically a verified resolution."
            : "No watch yet. A watch needs a staged plan with an approved S10 approval and a documented execution first."}
        </p>
      )}

      {current && (
        <WatchCard
          watch={current}
          observations={obsByWatch.get(current.id) ?? []}
          fresh={freshByWatch.get(current.id) ?? true}
        />
      )}

      {history.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-neutral-300">WATCH HISTORY (preserved for audit)</p>
          {history.slice(0, 5).map((w) => (
            <WatchCard key={w.id} watch={w} observations={obsByWatch.get(w.id) ?? []} fresh={freshByWatch.get(w.id) ?? true} compact />
          ))}
        </div>
      )}
      <p className="mt-1 text-[10px] text-neutral-600">
        Verified actions are not verified resolutions. Customer silence is not proof. Confirming here never closes the
        incident.
      </p>
    </div>
  );
}

function WatchCard({
  watch,
  observations,
  fresh,
  compact,
}: {
  watch: WatchRow;
  observations: WatchObservation[];
  fresh: boolean;
  compact?: boolean;
}) {
  const st = statusLabel(watch.status);
  return (
    <div className="mt-2 rounded-md border border-[rgba(255,255,255,0.12)] bg-[rgba(0,0,0,0.25)] px-3 py-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${st.cls}`}>{st.text}</span>
        <span className="font-mono text-[10px] text-neutral-500">
          baseline fp {watch.baseline_fingerprint.slice(0, 8)}
          {!fresh && " · STALE — evidence moved on, refresh before confirming"}
          {watch.last_evaluation_at ? ` · evaluated ${new Date(watch.last_evaluation_at).toLocaleString()}` : " · never evaluated"}
        </span>
      </p>
      <p className="mt-1 text-[11px] text-neutral-400">
        <span className="text-neutral-500">Monitored intervention:</span>{" "}
        {watch.execution_id ? `manual record ${watch.execution_id.slice(0, 8)}` : "documented intervention"}
        {watch.plan_id ? ` · plan ${watch.plan_id.slice(0, 8)}` : ""}
      </p>
      <p className="mt-0.5 text-[11px] text-neutral-400">
        <span className="text-neutral-500">Baseline:</span> {watch.baseline_summary || "(no summary recorded)"}
      </p>
      {!compact && observations.length === 0 && (
        <p className="mt-1 text-[11px] text-neutral-500">
          No follow-up evidence yet. Improvement, persistence, or regression will appear here with source references.
        </p>
      )}
      {observations.length > 0 && (
        <ol className="mt-1 space-y-1">
          {observations.slice(-12).map((o) => (
            <li key={o.id} className="rounded border border-[rgba(255,255,255,0.08)] px-2 py-1">
              <p className="font-mono text-[10px] text-neutral-500">
                {kindLabel(o.kind)}
                {o.message_id ? ` · msg ${o.message_id.slice(0, 8)}` : ""}
                {o.created_by_user_id ? ` · by ${o.created_by_user_id.slice(0, 8)}` : ""}
              </p>
              {o.excerpt && <p className="mt-0.5 text-[11px] text-neutral-300">{o.excerpt}</p>}
            </li>
          ))}
        </ol>
      )}
      {watch.status === "resolution_confirmed" && (
        <p className="mt-1 text-[11px] text-[#9AFF8D]">
          Resolution confirmed{watch.confirmed_by_user_id ? ` by ${watch.confirmed_by_user_id.slice(0, 8)}` : ""}. The
          incident itself stays open until S12 closure.
        </p>
      )}
    </div>
  );
}
