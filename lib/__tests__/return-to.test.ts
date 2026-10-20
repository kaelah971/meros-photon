import { describe, expect, it } from "vitest";
import { loginUrl, sanitizeReturnTo } from "../return-to";

describe("sanitizeReturnTo", () => {
  it("keeps valid staff deep links intact", () => {
    expect(sanitizeReturnTo("/app/workspaces/novacart-support/incidents")).toBe(
      "/app/workspaces/novacart-support/incidents",
    );
    expect(sanitizeReturnTo("/app/workspaces/acme")).toBe("/app/workspaces/acme");
    expect(sanitizeReturnTo("/app")).toBe("/app");
    expect(sanitizeReturnTo("/app/workspaces/a/incidents/i?tab=evidence")).toBe(
      "/app/workspaces/a/incidents/i?tab=evidence",
    );
  });

  it("rejects external, protocol-relative, and unsafe targets", () => {
    expect(sanitizeReturnTo("https://evil.example/app")).toBeNull();
    expect(sanitizeReturnTo("//evil.example/app")).toBeNull();
    expect(sanitizeReturnTo("javascript:alert(1)")).toBeNull();
    expect(sanitizeReturnTo("/app\\..\\evil")).toBeNull();
    expect(sanitizeReturnTo("/support/novacart-support")).toBeNull();
    expect(sanitizeReturnTo("/login")).toBeNull();
    expect(sanitizeReturnTo("")).toBeNull();
    expect(sanitizeReturnTo(null)).toBeNull();
    expect(sanitizeReturnTo("/app/\"onmouseover")).toBeNull();
    expect(sanitizeReturnTo(`/app/${"x".repeat(300)}`)).toBeNull();
  });
});

describe("loginUrl", () => {
  it("carries safe destinations and falls back to plain /login", () => {
    expect(loginUrl("/app/workspaces/novacart-support/incidents")).toBe(
      "/login?next=%2Fapp%2Fworkspaces%2Fnovacart-support%2Fincidents",
    );
    expect(loginUrl("https://evil.example/")).toBe("/login");
    expect(loginUrl(null)).toBe("/login");
  });
});

describe("workspace layout gating (source contract)", () => {
  it("renders the access screen instead of silently redirecting to /app", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/app/workspaces/[slug]/layout.tsx", "utf8");
    expect(src).toContain("WorkspaceAccess");
    // The old blind redirect for unknown/foreign slugs must be gone.
    expect(src).not.toMatch(/if \(!ws\) redirect\("\/app"\)/);
    // Membership is still verified server-side on every render.
    expect(src).toContain("getOwnedWorkspace(user.id, slug)");
  });

  it("switch-account preserves the exact destination client-side", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/workspace-access.tsx", "utf8");
    expect(src).toContain("window.location.pathname");
    expect(src).toContain("/login?next=");
    expect(src).toContain("authClient.signOut()");
  });
});
