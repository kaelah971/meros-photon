"use client";

import { authClient } from "@/lib/better-auth-client";
import Link from "next/link";
import { useState } from "react";
import { Eyebrow, PageBackdrop, Wordmark } from "@/components/meros-ui";

/**
 * Staff access screen: the signed-in account has no membership in the
 * requested workspace (or the slug is unknown — same screen, no
 * enumeration). Shows NOTHING private: only the visitor's own email and
 * the slug they typed. Switch account signs out via Better Auth, then
 * returns to login with the EXACT current staff page preserved.
 */
export function WorkspaceAccess({ email, slug }: { email: string; slug: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function switchAccount() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      // Capture the exact staff destination BEFORE signing out.
      const dest = `${window.location.pathname}${window.location.search}`;
      await authClient.signOut();
      window.location.href = `/login?next=${encodeURIComponent(dest)}`;
    } catch {
      setError("Could not sign you out. Please try again.");
      setBusy(false);
    }
  }

  return (
    <main className="relative mx-auto max-w-md px-6 py-16">
      <PageBackdrop />
      <div className="text-center">
        <Wordmark />
      </div>
      <div className="meros-card mt-6 rounded-xl p-6 sm:p-8">
        <Eyebrow>WORKSPACE ACCESS</Eyebrow>
        <h1 className="mt-2 text-2xl font-semibold text-[#F5F7F5]">
          This workspace needs a different account
        </h1>
        <p className="mt-2 text-[13px] leading-6 text-[#8E9B93]">
          You&apos;re signed in as <span className="text-[#F5F7F5]">{email}</span>, which
          doesn&apos;t have access to <span className="font-mono text-[#F5F7F5]">{slug}</span>.
        </p>
        <div className="mt-6 space-y-2">
          <button
            onClick={() => void switchAccount()}
            disabled={busy}
            className="w-full rounded-md bg-[#77FF75] px-5 py-2.5 text-sm font-semibold text-[#030806] transition-colors hover:bg-[#9AFF8D] disabled:opacity-40"
          >
            {busy ? "Signing out…" : "Switch account"}
          </button>
          <Link
            href="/app"
            className="block w-full rounded-md border border-[rgba(119,255,117,0.25)] px-5 py-2.5 text-center text-sm text-neutral-300 hover:border-[rgba(119,255,117,0.5)]"
          >
            Go to my organizations
          </Link>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-xs text-red-300">
            {error}
          </p>
        )}
        <p className="mt-4 text-xs text-[#8E9B93]">
          After switching, sign in as an owner of this workspace to continue where you left off.
        </p>
      </div>
    </main>
  );
}
