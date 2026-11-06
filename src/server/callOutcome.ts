/**
 * Classifies Vapi's endedReason into CallAttempt.status, applies the
 * end-of-call artifacts, and maps the outcome onto MDR's Agent 4 call_status
 * vocabulary. Same allowlist approach as Agent 2: unrecognized endedReasons
 * default to "failed" and are logged, never silently treated as completed.
 */
import type { HydratedDocument } from "mongoose";
import type { MdrCallStatus } from "../mdr/api.js";

const VOICEMAIL_REASONS = new Set(["voicemail"]);

const NO_ANSWER_REASONS = new Set([
  "customer-did-not-answer",
  "customer-busy",
  "twilio-reported-customer-misdialed",
  "call.ringing.sip-inbound-caller-hungup-before-call-connect",
]);

const NORMAL_COMPLETION_REASONS = new Set([
  "assistant-ended-call",
  "assistant-ended-call-with-hangup-task",
  "assistant-ended-call-after-message-spoken",
  "assistant-said-end-call-phrase",
  "assistant-forwarded-call",
  "customer-ended-call",
  "exceeded-max-duration",
  "manually-canceled",
  "silence-timed-out",
  "call.in-progress.twilio-completed-call",
  "call.in-progress.sip-completed-call",
  "vonage-completed",
]);

export type CallStatus = "completed" | "voicemail" | "no_answer" | "failed";

export function classifyCallStatus(endedReason: string | undefined): CallStatus {
  if (!endedReason) return "completed";
  if (VOICEMAIL_REASONS.has(endedReason)) return "voicemail";
  if (NO_ANSWER_REASONS.has(endedReason)) return "no_answer";
  if (NORMAL_COMPLETION_REASONS.has(endedReason)) return "completed";
  console.warn(`Unrecognized Vapi endedReason "${endedReason}" — defaulting to status "failed". Consider adding it to src/server/callOutcome.ts.`);
  return "failed";
}

/** Real conversation seconds from Vapi's own timestamps; 0 if never connected. */
function computeDurationSeconds(startedAt?: string, endedAt?: string): number {
  if (!startedAt || !endedAt) return 0;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.round((end - start) / 1000);
}

export function applyCallOutcome(
  attempt: HydratedDocument<any>,
  data: {
    endedReason?: string;
    transcript?: string;
    recordingUrl?: string;
    summary?: string;
    vapiStartedAt?: string;
    vapiEndedAt?: string;
  }
) {
  attempt.transcript = data?.transcript;
  attempt.recordingUrl = data?.recordingUrl;
  attempt.summary = data?.summary;
  attempt.endedReason = data?.endedReason;
  attempt.endedAt = new Date();
  attempt.durationSeconds = computeDurationSeconds(data?.vapiStartedAt, data?.vapiEndedAt);

  if (attempt.status === "in_progress") {
    attempt.status = classifyCallStatus(data?.endedReason);
  }

  // A tool call sets callResult mid-call. If none fired, record that
  // explicitly rather than leave it empty.
  if (!attempt.callResult) {
    if (attempt.status === "voicemail") attempt.callResult = "voicemail";
    else if (attempt.status === "completed") attempt.callResult = "connected";
  }
}

/**
 * Maps our outcome onto MDR's call_status. Returns null where MDR's list has
 * no honest equivalent — the caller skips the /result push rather than send a
 * misleading status:
 *   - "callback": MDR's Agent 4 list has no follow-up/callback status
 *     (Agent 2's FOLLOW_UP_REQUIRED doesn't exist here). The callback call's
 *     own outcome is reported when it happens. PENDING MDR CONFIRMATION.
 *   - status "failed": the call itself errored, not a business outcome.
 */
export function mapToMdrCallStatus(attempt: HydratedDocument<any>): MdrCallStatus | null {
  if (attempt?.status === "no_answer") return "NO_ANSWER";
  if (attempt?.status === "voicemail") return "LEFT_VOICEMAIL";

  switch (attempt?.callResult) {
    case "rep_assigned":
      return "ACCEPTED";
    case "declined":
      return "DECLINED";
    case "connected":
      return "CALL_DROPPED";
    default:
      return null;
  }
}

/** Human-readable result.message for MDR's /result. */
export function buildResultMessage(attempt: HydratedDocument<any>): string {
  const rep = attempt?.assignedRep;
  switch (attempt?.status === "no_answer" || attempt?.status === "voicemail" ? attempt.status : attempt?.callResult) {
    case "no_answer":
      return "No answer.";
    case "voicemail":
      return "Left a voicemail.";
    case "rep_assigned":
      return `Sales representative assigned: ${rep?.name ?? "unknown"}${rep?.isNewRep ? " (new rep)" : ""}.`;
    case "declined":
      return `Broker declined to assign a sales representative${attempt?.declineReason ? ` (${String(attempt.declineReason).replace(/_/g, " ")})` : ""}${attempt?.declineNote ? `: ${attempt.declineNote}` : "."}`;
    case "connected":
      return "Call connected but ended before a sales representative was assigned.";
    default:
      return attempt?.summary ?? "Call ended.";
  }
}
