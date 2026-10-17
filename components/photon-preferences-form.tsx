"use client";

import { useState } from "react";

export type PrefsView = {
  proactiveEnabled: boolean;
  quietHoursEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  timezone: string;
};

const TIMEZONES = [
  "Africa/Lagos",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

/**
 * S3 operator notification preferences: the operator edits ONLY their own
 * workspace-scoped settings. Strict client-side shape; server re-validates.
 * Non-test proactive sends honor these; explicit test sends stay manual.
 */
export default function PhotonPreferencesForm({
  workspaceSlug,
  initial,
}: {
  workspaceSlug: string;
  initial: PrefsView;
}) {
  const [form, setForm] = useState<PrefsView>(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/photon/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceSlug, ...form }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return;
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setSaving(false);
    }
  }

  const row = "flex items-center justify-between gap-2";
  const toggle =
    "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors";
  const knob = (on: boolean) =>
    `inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}`;

  return (
    <div className="mt-3 border-t border-[rgba(119,255,117,0.12)] pt-2.5">
      <p className="text-xs text-neutral-100">Notification preferences</p>
      <div className="mt-1.5 space-y-2 text-[11px] text-neutral-400">
        <div className={row}>
          <span>Proactive notifications</span>
          <button
            type="button"
            role="switch"
            aria-checked={form.proactiveEnabled}
            onClick={() => setForm((f) => ({ ...f, proactiveEnabled: !f.proactiveEnabled }))}
            className={`${toggle} ${form.proactiveEnabled ? "bg-[#2f9e44]" : "bg-neutral-600"}`}
          >
            <span className={knob(form.proactiveEnabled)} />
          </button>
        </div>
        <div className={row}>
          <span>Quiet hours</span>
          <button
            type="button"
            role="switch"
            aria-checked={form.quietHoursEnabled}
            onClick={() => setForm((f) => ({ ...f, quietHoursEnabled: !f.quietHoursEnabled }))}
            className={`${toggle} ${form.quietHoursEnabled ? "bg-[#2f9e44]" : "bg-neutral-600"}`}
          >
            <span className={knob(form.quietHoursEnabled)} />
          </button>
        </div>
        {form.quietHoursEnabled && (
          <div className="grid grid-cols-3 items-end gap-2">
            <label className="block">
              <span className="text-neutral-500">Start</span>
              <input
                type="time"
                value={form.quietStart}
                onChange={(e) => setForm((f) => ({ ...f, quietStart: e.target.value }))}
                className="mt-0.5 w-full rounded bg-[#06100B] px-2 py-1.5 text-neutral-100"
              />
            </label>
            <label className="block">
              <span className="text-neutral-500">End</span>
              <input
                type="time"
                value={form.quietEnd}
                onChange={(e) => setForm((f) => ({ ...f, quietEnd: e.target.value }))}
                className="mt-0.5 w-full rounded bg-[#06100B] px-2 py-1.5 text-neutral-100"
              />
            </label>
            <label className="block">
              <span className="text-neutral-500">Timezone</span>
              <select
                value={TIMEZONES.includes(form.timezone) ? form.timezone : "Africa/Lagos"}
                onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                className="mt-0.5 w-full rounded bg-[#06100B] px-2 py-1.5 text-neutral-100"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving || !dirty}
        className="mt-2 rounded-md bg-[#77FF75] px-3 py-1.5 text-xs font-medium text-[#030806] hover:bg-[#9AFF8D] disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? "Saving…" : dirty ? "Save preferences" : "Saved"}
      </button>
      {saved && !dirty && <p className="mt-1 text-[11px] text-[#9AFF8D]">Preferences saved.</p>}
      {saved && dirty && <p className="mt-1 text-[11px] text-neutral-500">Unsaved changes.</p>}
      {error && <p className="mt-1 text-[11px] text-red-300">Failed: {error}</p>}
    </div>
  );
}
