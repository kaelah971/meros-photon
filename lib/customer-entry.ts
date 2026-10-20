// Pure customer-entry helpers: workspace display titles and the
// per-browser entry flag that gates the "Continue as / switch" choice.
// No I/O, no auth — safe anywhere (client, server, tests).

/**
 * "NovaCart Customer Support" — normalizes any variant ("NovaCart",
 * "NovaCart Support", "NovaCart Customer Support", any casing) to
 * "<Base> Customer Support", so the UI never shows "… Support Support".
 */
export function supportTitle(workspaceName: string | null | undefined): string {
  const name = (workspaceName ?? "").trim();
  if (!name) return "Customer Support";
  const base = name.replace(/\s+(customer\s+)?support\s*$/i, "").trim();
  if (!base) return "Customer Support";
  return `${base} Customer Support`;
}

/** sessionStorage key recording that this browser accepted this identity. */
export function entryFlagKey(workspaceSlug: string, email: string): string {
  return `meros:entered:${workspaceSlug.trim().toLowerCase()}:${email.trim().toLowerCase()}`;
}
