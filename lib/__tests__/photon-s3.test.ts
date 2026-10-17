import { describe, expect, it } from "vitest";
import {
  isQuietNow,
  isValidTime,
  isValidTimezone,
  validatePreferences,
} from "../photon/preferences";
import { sendOperatorNotification, type NotifyDeps } from "../photon/notify";

// S3 tests: preference validation, quiet-hours math, suppression gates,
// and test-bypass behavior. Zero Neon, zero network — fakes only.

const WS = "ws-1";
const USER = "user-1";
const THREAD = "thread-1";

// Noon UTC on a fixed date (deterministic across machine timezones).
const NOON_UTC = new Date("2026-06-15T12:00:00.000Z");

function notifyFakes(overrides: Partial<NotifyDeps> = {}) {
  const sends: { threadId: string; text: string }[] = [];
  const claimed: string[] = [];
  const base: NotifyDeps = {
    findBindingForOperator: async () => ({
      id: "bind-1",
      workspaceId: WS,
      operatorUserId: USER,
      threadId: THREAD,
    }),
    checkStaff: async () => {},
    getPreferences: async () => ({
      proactiveEnabled: true,
      quietHoursEnabled: false,
      quietStart: "22:00",
      quietEnd: "07:00",
      timezone: "Africa/Lagos",
      malformed: false,
    }),
    claimProactive: async (input) => {
      claimed.push(input.idempotencyKey);
      return { id: `out-${claimed.length}`, status: "received", providerMessageId: null, deduped: false };
    },
    markSent: async () => {},
    markFailed: async () => {},
    postToThread: async (threadId, text) => {
      sends.push({ threadId, text });
      return { providerId: "prov-1" };
    },
  };
  return { deps: { ...base, ...overrides } as NotifyDeps, sends, claimed };
}

const BASE = {
  workspaceId: WS,
  operatorUserId: USER,
  type: "recovery_approval_required" as const,
  body: "Approval needed",
  idempotencyKey: "k-1",
  isTest: false,
};

describe("preference validation", () => {
  it("accepts a complete valid body", () => {
    expect(
      validatePreferences({
        proactiveEnabled: false,
        quietHoursEnabled: true,
        quietStart: "22:00",
        quietEnd: "07:00",
        timezone: "Africa/Lagos",
      }),
    ).toEqual({
      ok: true,
      value: {
        proactiveEnabled: false,
        quietHoursEnabled: true,
        quietStart: "22:00",
        quietEnd: "07:00",
        timezone: "Africa/Lagos",
      },
    });
  });

  it("rejects non-boolean toggles, bad times, equal window, bad timezone", () => {
    expect(validatePreferences({ proactiveEnabled: "yes", quietHoursEnabled: false, quietStart: "22:00", quietEnd: "07:00", timezone: "UTC" }).ok).toBe(false);
    expect(validatePreferences({ proactiveEnabled: true, quietHoursEnabled: 1, quietStart: "22:00", quietEnd: "07:00", timezone: "UTC" }).ok).toBe(false);
    expect(validatePreferences({ proactiveEnabled: true, quietHoursEnabled: true, quietStart: "25:00", quietEnd: "07:00", timezone: "UTC" }).ok).toBe(false);
    expect(validatePreferences({ proactiveEnabled: true, quietHoursEnabled: true, quietStart: "07:00", quietEnd: "07:00", timezone: "UTC" }).ok).toBe(false);
    expect(validatePreferences({ proactiveEnabled: true, quietHoursEnabled: false, quietStart: "22:00", quietEnd: "07:00", timezone: "Mars/Olympus" }).ok).toBe(false);
    expect(validatePreferences({ proactiveEnabled: true, quietHoursEnabled: false, quietStart: "22:00", quietEnd: "07:00", timezone: "" }).ok).toBe(false);
  });

  it("helpers accept edge times and reject garbage", () => {
    expect(isValidTime("00:00")).toBe(true);
    expect(isValidTime("23:59")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("7:00")).toBe(false);
    expect(isValidTimezone("Africa/Lagos")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });
});

describe("quiet-hours math", () => {
  // 12:00 UTC = 13:00 Lagos (UTC+1, no DST).
  const lagos = { quietHoursEnabled: true, quietStart: "22:00", quietEnd: "07:00", timezone: "Africa/Lagos" };

  it("disabled flag never quiets", () => {
    expect(isQuietNow({ ...lagos, quietHoursEnabled: false }, NOON_UTC)).toBe(false);
  });

  it("overnight window: quiet late night, loud midday", () => {
    expect(isQuietNow(lagos, new Date("2026-06-15T23:30:00.000Z"))).toBe(true); // 00:30 Lagos
    expect(isQuietNow(lagos, new Date("2026-06-15T05:00:00.000Z"))).toBe(true); // 06:00 Lagos
    expect(isQuietNow(lagos, NOON_UTC)).toBe(false); // 13:00 Lagos
    expect(isQuietNow(lagos, new Date("2026-06-15T20:00:00.000Z"))).toBe(false); // 21:00 Lagos
  });

  it("daytime window with exact boundary semantics [start, end)", () => {
    const day = { quietHoursEnabled: true, quietStart: "09:00", quietEnd: "17:00", timezone: "UTC" };
    expect(isQuietNow(day, new Date("2026-06-15T09:00:00.000Z"))).toBe(true);
    expect(isQuietNow(day, new Date("2026-06-15T16:59:00.000Z"))).toBe(true);
    expect(isQuietNow(day, new Date("2026-06-15T17:00:00.000Z"))).toBe(false);
    expect(isQuietNow(day, new Date("2026-06-15T08:59:00.000Z"))).toBe(false);
  });

  it("timezone shifts the window (same instant, different zones)", () => {
    const at = new Date("2026-06-15T12:00:00.000Z");
    const lagosDay = { quietHoursEnabled: true, quietStart: "09:00", quietEnd: "17:00", timezone: "Africa/Lagos" }; // 13:00 local -> quiet
    const nyDay = { quietHoursEnabled: true, quietStart: "09:00", quietEnd: "17:00", timezone: "America/New_York" }; // 08:00 local -> loud
    expect(isQuietNow(lagosDay, at)).toBe(true);
    expect(isQuietNow(nyDay, at)).toBe(false);
  });

  it("invalid config fails open (never blocks on unreadable prefs)", () => {
    expect(isQuietNow({ quietHoursEnabled: true, quietStart: "xx", quietEnd: "07:00", timezone: "UTC" }, NOON_UTC)).toBe(false);
    expect(isQuietNow({ quietHoursEnabled: true, quietStart: "22:00", quietEnd: "07:00", timezone: "Nope/Nowhere" }, NOON_UTC)).toBe(false);
  });
});

describe("suppression enforcement", () => {
  it("disabled toggle suppresses without sending or claiming", async () => {
    const { deps, sends, claimed } = notifyFakes({
      getPreferences: async () => ({
        proactiveEnabled: false,
        quietHoursEnabled: false,
        quietStart: "22:00",
        quietEnd: "07:00",
        timezone: "UTC",
        malformed: false,
      }),
    });
    const res = await sendOperatorNotification(BASE, deps);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "suppressed_disabled", recoverable: true }));
    expect(res.ok === false && (res as { suppressed?: boolean }).suppressed).toBe(true);
    expect(sends).toHaveLength(0);
    expect(claimed).toHaveLength(0);
  });

  it("quiet hours suppress without sending or claiming", async () => {
    const { deps, sends, claimed } = notifyFakes({
      getPreferences: async () => ({
        proactiveEnabled: true,
        quietHoursEnabled: true,
        quietStart: "00:00",
        quietEnd: "23:59",
        timezone: "UTC",
        malformed: false,
      }),
    });
    const res = await sendOperatorNotification(BASE, deps);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "suppressed_quiet_hours", recoverable: true }));
    expect(sends).toHaveLength(0);
    expect(claimed).toHaveLength(0);
  });

  it("non-quiet sends proceed (idempotency consumed only on real attempts)", async () => {
    const { deps, sends, claimed } = notifyFakes();
    const res = await sendOperatorNotification(BASE, deps);
    expect(res.ok).toBe(true);
    expect(sends).toHaveLength(1);
    expect(claimed).toEqual(["k-1"]);
  });
});

describe("malformed stored preferences fail closed", () => {
  const malformedPrefs = {
    proactiveEnabled: true,
    quietHoursEnabled: false,
    quietStart: "22:00",
    quietEnd: "07:00",
    timezone: "UTC",
    malformed: true,
  };

  it("non-test send is suppressed without sending or claiming", async () => {
    const { deps, sends, claimed } = notifyFakes({
      getPreferences: async () => malformedPrefs,
    });
    const res = await sendOperatorNotification(BASE, deps);
    expect(res).toEqual(
      expect.objectContaining({ ok: false, code: "suppressed_prefs_invalid", recoverable: true }),
    );
    expect(res.ok === false && (res as { suppressed?: boolean }).suppressed).toBe(true);
    expect(sends).toHaveLength(0);
    expect(claimed).toHaveLength(0);
  });

  it("explicit connectivity test retains its bypass for malformed prefs", async () => {
    const { deps, sends } = notifyFakes({
      getPreferences: async () => malformedPrefs,
    });
    const res = await sendOperatorNotification({ ...BASE, isTest: true }, deps);
    expect(res.ok).toBe(true);
    expect(sends).toHaveLength(1);
  });

  it("missing row is NOT malformed: defaults apply and send proceeds", async () => {
    const { deps, sends } = notifyFakes({
      getPreferences: async () => ({
        proactiveEnabled: true,
        quietHoursEnabled: false,
        quietStart: "22:00",
        quietEnd: "07:00",
        timezone: "UTC",
        malformed: false,
      }),
    });
    const res = await sendOperatorNotification(BASE, deps);
    expect(res.ok).toBe(true);
    expect(sends).toHaveLength(1);
  });
});

describe("explicit connectivity test bypass", () => {
  it("test sends during quiet hours (still gated on binding/staff/thread)", async () => {
    const { deps, sends } = notifyFakes({
      getPreferences: async () => ({
        proactiveEnabled: false,
        quietHoursEnabled: true,
        quietStart: "00:00",
        quietEnd: "23:59",
        timezone: "UTC",
        malformed: false,
      }),
    });
    const res = await sendOperatorNotification({ ...BASE, isTest: true }, deps);
    expect(res.ok).toBe(true);
    expect(sends).toHaveLength(1);
  });

  it("test still requires a conversation address", async () => {
    const { deps, sends } = notifyFakes({
      findBindingForOperator: async () => ({ id: "b", workspaceId: WS, operatorUserId: USER, threadId: null }),
    });
    const res = await sendOperatorNotification({ ...BASE, isTest: true }, deps);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "no_conversation" }));
    expect(sends).toHaveLength(0);
  });

  it("test still requires staff", async () => {
    const { deps, sends } = notifyFakes({
      checkStaff: async () => { throw new Error("denied"); },
    });
    const res = await sendOperatorNotification({ ...BASE, isTest: true }, deps);
    expect(res).toEqual(expect.objectContaining({ ok: false, code: "not_staff" }));
    expect(sends).toHaveLength(0);
  });
});
