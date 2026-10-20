import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CUSTOMER_SIGN_OUT_ERROR, signOutCustomerSession } from "../customer-signout";

describe("customer sign-out behavior", () => {
  it("calls Better Auth signOut and refreshes the current route only on success", async () => {
    const signOut = vi.fn().mockResolvedValue({ data: { success: true }, error: null });
    const refreshCurrentRoute = vi.fn();

    const result = await signOutCustomerSession({ signOut, refreshCurrentRoute });

    expect(result).toEqual({ ok: true });
    expect(signOut).toHaveBeenCalledOnce();
    expect(refreshCurrentRoute).toHaveBeenCalledOnce();
  });

  it("does not refresh and returns a readable message when Better Auth returns an error", async () => {
    const signOut = vi.fn().mockResolvedValue({ data: null, error: { status: 500, statusText: "nope" } });
    const refreshCurrentRoute = vi.fn();

    const result = await signOutCustomerSession({ signOut, refreshCurrentRoute });

    expect(result).toEqual({ ok: false, message: CUSTOMER_SIGN_OUT_ERROR });
    expect(refreshCurrentRoute).not.toHaveBeenCalled();
  });

  it("does not refresh and returns a readable message when Better Auth throws", async () => {
    const signOut = vi.fn().mockRejectedValue(new Error("internal auth detail"));
    const refreshCurrentRoute = vi.fn();

    const result = await signOutCustomerSession({ signOut, refreshCurrentRoute });

    expect(result).toEqual({ ok: false, message: "Could not sign you out. Please try again." });
    expect(refreshCurrentRoute).not.toHaveBeenCalled();
  });

  it("wires all visible sign-out controls (header, panel, entry choice) to the same guarded handler", () => {
    const src = readFileSync("components/support-chat.tsx", "utf8");

    expect(src.match(/const signOutHere = useCallback/g)?.length).toBe(1);
    expect(src.match(/void signOutHere\(\)/g)?.length).toBe(3);
    expect(src).toContain("signOutInFlightRef.current");
    expect(src.match(/disabled=\{signingOut\}/g)?.length).toBe(3);
    expect(src).toContain("Signing out…");
    expect(src).toContain("Use a different account");
  });

  it("keeps normal support chat send behavior present", () => {
    const src = readFileSync("components/support-chat.tsx", "utf8");

    expect(src).toContain("const send = useCallback(async () =>");
    expect(src).toContain('fetch("/api/chat"');
    expect(src).toContain("{sending ? \"Sending…\" : \"Send\"}");
  });
});
