import "server-only";
import type { DetectResult } from "./detection";
import type { logRadarDecision } from "./radar-decision";

/**
 * Shared Radar evaluation for a detection outcome — used by the live chat
 * chain AND the deferred-recovery sweep alike, so a recovered report that
 * completes a qualifying candidate alerts exactly like a live one.
 *
 * Single gate (genuinely new conversation joining), one real alert
 * attempt via the existing deps, one observable decision record.
 * Never throws: every failure degrades to a safe-skipped decision so a
 * broken Radar path can never break chat or recovery.
 */
export async function evaluateRadarForOutcome(input: {
  workspaceId: string;
  workspaceSlug: string;
  outcome: DetectResult;
}): Promise<{ evaluated: boolean }> {
  const { outcome, workspaceId, workspaceSlug } = input;
  try {
    const { shouldEvaluateRadar } = await import("./radar");
    if (!shouldEvaluateRadar(outcome)) return { evaluated: false };
    const candidateId =
      "candidateId" in outcome && typeof outcome.candidateId === "string" ? outcome.candidateId : null;
    if (!candidateId) return { evaluated: false };
    const candPrefix = candidateId.slice(0, 8);
    const { logRadarDecision, mapRadarResultToOutcome } = await import("./radar-decision");
    const emit: (fields: Omit<Parameters<typeof logRadarDecision>[0], "workspaceSlug">) => void = (fields) =>
      void logRadarDecision({ ...fields, workspaceSlug });
    try {
      const { maybeSendRadarAlert, realRadarDeps } = await import("./radar");
      const radar = await maybeSendRadarAlert(workspaceId, candidateId, await realRadarDeps());
      console.log(`[chat] radar ${candPrefix} ${radar.action}`);
      if (radar.action === "alerted") {
        emit({
          outcome: mapRadarResultToOutcome(radar),
          candidateIdPrefix: candPrefix,
          sent: radar.sent,
          deduped: radar.deduped,
          suppressed: radar.suppressed,
          reason: radar.suppressedReasons?.[0],
        });
      } else if (radar.action === "ineligible") {
        emit({ outcome: mapRadarResultToOutcome(radar), candidateIdPrefix: candPrefix, reason: radar.reason });
      } else if (radar.action === "no_recipients") {
        emit({ outcome: mapRadarResultToOutcome(radar), candidateIdPrefix: candPrefix });
      } else {
        emit({ outcome: mapRadarResultToOutcome(radar), candidateIdPrefix: candPrefix, reason: radar.reason });
      }
    } catch (e) {
      console.log(`[chat] radar skipped safely: ${e instanceof Error ? e.message : e}`);
      emit({ outcome: "notification_failed", candidateIdPrefix: candPrefix, reason: "radar_wiring_failed" });
    }
    return { evaluated: true };
  } catch {
    // Import/wiring failure: observable skip, never a throw into chat.
    try {
      const { logRadarDecision: log } = await import("./radar-decision");
      log({ outcome: "notification_failed", workspaceSlug, candidateIdPrefix: "none", reason: "radar_wiring_failed" });
    } catch {
      // Logging must never break the request path.
    }
    return { evaluated: false };
  }
}
