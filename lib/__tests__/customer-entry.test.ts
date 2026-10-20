import React from "react";
import { describe, expect, it, vi } from "vitest";
import { entryFlagKey, supportTitle } from "../customer-entry";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

describe("supportTitle", () => {
  it("normalizes every variant to '<Base> Customer Support'", () => {
    expect(supportTitle("NovaCart")).toBe("NovaCart Customer Support");
    expect(supportTitle("NovaCart Support")).toBe("NovaCart Customer Support");
    expect(supportTitle("NovaCart Customer Support")).toBe("NovaCart Customer Support");
    expect(supportTitle("novacart customer support")).toBe("novacart Customer Support");
    expect(supportTitle("Northstar Support")).toBe("Northstar Customer Support");
  });

  it("never duplicates Support and handles blanks", () => {
    for (const name of ["NovaCart", "NovaCart Support", "NovaCart Customer Support"]) {
      expect(supportTitle(name)).not.toMatch(/support.*support/i);
    }
    expect(supportTitle("")).toBe("Customer Support");
    expect(supportTitle(null)).toBe("Customer Support");
  });
});

describe("entryFlagKey", () => {
  it("scopes the choice flag per workspace and identity", () => {
    const a = entryFlagKey("novacart-support", "Joy@Example.com");
    const b = entryFlagKey("novacart-support", "other@example.com");
    const c = entryFlagKey("northstar", "Joy@Example.com");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toContain("novacart-support");
    expect(a).toContain("joy@example.com");
  });
});

describe("support route entry routing", () => {
  vi.mock("next/navigation", () => ({
    notFound: () => {
      throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
    },
    useRouter: () => ({ refresh: () => {} }),
  }));
  vi.mock("@/lib/auth", () => ({ currentUser: async () => (globalThis as { __cu?: unknown }).__cu ?? null }));
  vi.mock("@/lib/db", async (importOriginal) => {
    const orig = (await importOriginal()) as Record<string, unknown>;
    return {
      ...orig,
      getWorkspaceBySlug: async (slug: string) =>
        slug === "novacart-support" ? { id: "ws-9", slug, name: "NovaCart Support" } : null,
    };
  });

  const render = async () => {
    const { default: SupportPage } = await import("@/app/support/[workspaceSlug]/page");
    return SupportPage({ params: Promise.resolve({ workspaceSlug: "novacart-support" }) });
  };

  it("anonymous visitors get the customer gate (never chat, never /app)", async () => {
    (globalThis as { __cu?: unknown }).__cu = null;
    const el = (await render()) as { type: unknown; props: Record<string, unknown> };
    const { CustomerGate } = await import("@/components/customer-gate");
    expect(el.type).toBe(CustomerGate);
    expect(el.props.workspaceName).toBe("NovaCart Support");
  });

  it("authenticated visitors go straight into chat with session identity", async () => {
    (globalThis as { __cu?: unknown }).__cu = { id: "u1", email: "joy@gmail.com" };
    const el = (await render()) as { type: unknown; props: Record<string, unknown> };
    const { SupportChat } = await import("@/components/support-chat");
    expect(el.type).toBe(SupportChat);
    expect(el.props.sessionEmail).toBe("joy@gmail.com");
    expect(el.props.initialWorkspaceSlug).toBe("novacart-support");
    expect(el.props.lockWorkspace).toBe(true);
  });

  it("unknown workspace still 404s", async () => {
    (globalThis as { __cu?: unknown }).__cu = null;
    const { default: SupportPage } = await import("@/app/support/[workspaceSlug]/page");
    await expect(
      SupportPage({ params: Promise.resolve({ workspaceSlug: "nope" }) }),
    ).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
  });
});
