"use client";

import { authClient } from "@/lib/better-auth-client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Eyebrow, Field, PageBackdrop, Wordmark, inputClass } from "@/components/meros-ui";
import { sanitizeReturnTo } from "@/lib/return-to";
import { validateDisplayName } from "@/lib/auth-crypto";

function AuthForm({ mode }: { mode: "signup" | "login" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Post-auth destination: only a validated internal staff path survives.
  // Plain /login or /signup visits keep the long-standing /app landing.
  const next = sanitizeReturnTo(searchParams.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      // Better Auth email/password (server at /api/auth/[...all]). Same UI,
      // same 10+ char password rule (enforced server-side by Better Auth).
      if (mode === "signup") {
        try {
          validateDisplayName(displayName);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Please enter your name.");
          setBusy(false);
          return;
        }
      }
      const result =
        mode === "signup"
          ? await authClient.signUp.email({
              email: email.trim(),
              password,
              name: validateDisplayName(displayName),
            })
          : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) {
        setError(friendlyAuthError(result.error.message) ?? "Something went wrong.");
        return;
      }
      router.push(next ?? "/app");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-x-clip bg-[#030806]">
      <PageBackdrop />
      <div className="relative mx-auto grid max-w-4xl gap-8 px-6 py-16 md:grid-cols-[1fr_1.2fr] md:py-24">
        <div className="hidden md:block">
          <Wordmark size="text-base" />
          <p className="font-display mt-6 text-xl font-bold leading-8 tracking-wide">
            Support memory
            <br />
            that <span className="text-[#77FF75]">compounds</span>.
          </p>
          <ol className="mt-6 space-y-3 text-[13px] leading-5 text-[#8E9B93]">
            {["Customer asks", "Meros remembers", "Organization learns"].map((s, i) => (
              <li key={s} className="flex items-center gap-3">
                <span className="font-display text-xs font-bold text-[#4CA862]">0{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <Link href="/" aria-label="Meros home" className="md:hidden">
            <Wordmark />
          </Link>
          <div className="meros-card mt-4 rounded-xl p-6 sm:p-8 md:mt-0">
            <Eyebrow>{mode === "signup" ? "CREATE YOUR OWNER ACCOUNT" : "WELCOME BACK"}</Eyebrow>
            <h1 className="mt-2 text-2xl font-semibold text-[#F5F7F5]">
              {mode === "signup" ? "Create your owner account" : "Sign in"}
            </h1>
            <p className="mt-1 text-[13px] text-[#8E9B93]">
              {mode === "signup"
                ? "One account owns your organizations and support workspaces."
                : "Pick up where your support operation left off."}
            </p>
            <div className="mt-6 space-y-3">
              <Field label="Work email">
                <input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  type="email"
                  autoComplete="email"
                  className={inputClass}
                />
              </Field>
              {mode === "signup" && (
                <Field label="Display name (optional)">
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    autoComplete="name"
                    className={inputClass}
                  />
                </Field>
              )}
              <Field label={mode === "signup" ? "Password (10+ characters)" : "Password"}>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                  className={inputClass}
                />
              </Field>
              {error && (
                <p role="alert" className="text-xs text-red-300">
                  {error}
                </p>
              )}
              <button
                onClick={() => void submit()}
                disabled={busy || !email.trim() || !password || (mode === "signup" && displayName.trim().length < 2)}
                className="w-full rounded-md bg-[#77FF75] px-5 py-2.5 text-sm font-semibold text-[#030806] transition-colors hover:bg-[#9AFF8D] disabled:opacity-40"
              >
                {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
              </button>
            </div>
            <p className="mt-4 text-xs text-[#8E9B93]">
              {mode === "signup" ? (
                <>Already have an account? <Link href="/login" className="text-[#9AFF8D] hover:underline">Sign in</Link></>
              ) : (
                <>New to Meros? <Link href="/signup" className="text-[#9AFF8D] hover:underline">Create an account</Link></>
              )}
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

/** Map Better Auth failures to safe, non-enumerating UI copy. */
function friendlyAuthError(message: string | undefined): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("password")) return "Invalid email or password.";
  if (m.includes("not found") || m.includes("invalid email")) return "Invalid email or password.";
  if (m.includes("already exists") || m.includes("already registered"))
    return "An account with this email already exists.";
  return "Something went wrong.";
}

export function SignupPage() {
  return <AuthForm mode="signup" />;
}

export function LoginPage() {
  return <AuthForm mode="login" />;
}
