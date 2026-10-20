// Safe post-login destinations. Pure — shared by middleware (server),
// login form (client), and tests. Only validated internal staff-console
// paths survive; everything else (external, protocol-relative, scheme,
// backslashes, non-/app paths) yields null and callers fall back to /app.

const SAFE_NEXT = /^\/app(\/[^\s\\]*)?$/;
const MAX_NEXT_LENGTH = 256;

/** Return the validated internal path, or null when unsafe/absent. */
export function sanitizeReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.length > MAX_NEXT_LENGTH) return null;
  if (!t.startsWith("/")) return null;
  if (t.startsWith("//")) return null;
  if (/["'<>\\]/.test(t)) return null;
  if (!SAFE_NEXT.test(t)) return null;
  return t;
}

/** Login URL carrying a validated destination (or plain /login). */
export function loginUrl(next: string | null): string {
  const safe = next ? sanitizeReturnTo(next) : null;
  return safe ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}
