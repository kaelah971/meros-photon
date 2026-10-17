import { currentUser } from "@/lib/auth";
import { getWorkspaceBySlug } from "@/lib/db";
import { resolveActiveBindingForOperator } from "@/lib/photon/bindings";
import { getPreferences } from "@/lib/photon/preferences";
import { requireStaff } from "@/lib/support-ops";
import PhotonPairingManager from "@/components/photon-pairing-manager";
import PhotonPreferencesForm from "@/components/photon-preferences-form";
import PhotonTestNotify from "@/components/photon-test-notify";

function Pill({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-display tracking-[0.15em] ${
        on
          ? "border-[rgba(119,255,117,0.4)] text-[#9AFF8D]"
          : "border-[rgba(255,255,255,0.14)] text-neutral-400"
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-1.5 w-1.5 rounded-full ${on ? "bg-[#77FF75]" : "bg-neutral-500"}`}
      />
      {on ? onLabel : offLabel}
    </span>
  );
}

/**
 * S3 iMessage Operator section: connection status, proactive readiness,
 * notification preferences, pairing management, and the S2 test action —
 * one compact surface so operators never need DevTools to pair iMessage.
 * Staff-only: non-members see nothing (page layout already gates, and every
 * action re-checks requireStaff server-side).
 */
export default async function PhotonOperatorPanel({ workspaceSlug }: { workspaceSlug: string }) {
  const user = await currentUser();
  if (!user) return null;
  const ws = await getWorkspaceBySlug(workspaceSlug);
  if (!ws) return null;
  try {
    await requireStaff(user.id, ws.id);
  } catch {
    return null;
  }

  const binding = await resolveActiveBindingForOperator(ws.id, user.id).catch(() => null);
  const prefs = await getPreferences(ws.id, user.id).catch(() => null);
  const paired = binding !== null;
  const threadReady = Boolean(binding?.thread_id);
  const proactiveOn = prefs?.proactiveEnabled !== false;

  return (
    <section
      aria-label="iMessage Operator"
      className="mt-3 rounded-md border border-[rgba(119,255,117,0.14)] bg-[rgba(10,27,18,0.72)] px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-100">iMessage Operator</p>
        <Pill on={paired} onLabel="CONNECTED" offLabel="NOT PAIRED" />
      </div>
      <dl className="mt-2 space-y-1 text-[11px] text-neutral-400">
        <div className="flex justify-between gap-2">
          <dt>Proactive notifications</dt>
          <dd className="text-neutral-100">{proactiveOn ? "ON" : "OFF"}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Quiet hours</dt>
          <dd className="text-neutral-100">
            {prefs?.quietHoursEnabled
              ? `${prefs.quietStart}–${prefs.quietEnd} ${prefs.timezone}`
              : "OFF"}
          </dd>
        </div>
        {paired && (
          <div className="flex justify-between gap-2">
            <dt>Last activity</dt>
            <dd className="text-neutral-100">
              {binding?.last_seen_at
                ? new Date(binding.last_seen_at).toLocaleString()
                : "—"}
            </dd>
          </div>
        )}
        {paired && !threadReady && (
          <p className="text-amber-200/90">
            Connected, but no conversation recorded yet — send `stats` from iMessage once to enable proactive messages.
          </p>
        )}
      </dl>
      <PhotonPairingManager
        workspaceSlug={ws.slug}
        activeBinding={
          binding ? { id: binding.id, lastSeenAt: binding.last_seen_at } : null
        }
      />
      <PhotonPreferencesForm
        workspaceSlug={ws.slug}
        initial={{
          proactiveEnabled: prefs?.proactiveEnabled ?? true,
          quietHoursEnabled: prefs?.quietHoursEnabled ?? false,
          quietStart: prefs?.quietStart ?? "22:00",
          quietEnd: prefs?.quietEnd ?? "07:00",
          timezone: prefs?.timezone ?? "Africa/Lagos",
        }}
      />
      <PhotonTestNotify workspaceSlug={ws.slug} />
    </section>
  );
}
