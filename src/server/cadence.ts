/**
 * Attempt cadence — same as the IRS agent:
 *   1st call: immediately, straight off MDR's webhook (mdrWebhook.ts) — no
 *     calling-window gate. MDR only pushes the webhook when it wants the
 *     contact called now.
 *   2nd call: 1 hour after the 1st, calling-window gated (cron)
 *   3rd call: 2 hours after the 2nd, calling-window gated (cron)
 *   4th call: next business morning (cron)
 * Max 4 attempts per outreach contact. A broker-requested callback replaces
 * the cadence for the next attempt (dispatch.ts) but still counts toward the 4.
 */
import { nextCallingWindowOpen, nextBusinessMorning } from "./callingWindow.js";

export const MAX_CALL_ATTEMPTS = 4;

const OFFSET_MINUTES_FROM_PREVIOUS: Record<number, number> = {
  2: 60,
  3: 120,
};

export function computeAttemptSchedule(params: {
  attemptNumber: number;
  timezone: string;
  previousAttemptAt?: Date;
}): Date {
  const { attemptNumber, timezone, previousAttemptAt } = params;

  if (attemptNumber === 1) return new Date();

  if (!previousAttemptAt) throw new Error(`Attempt ${attemptNumber} requires previousAttemptAt`);

  if (attemptNumber === 4) return nextBusinessMorning(timezone, previousAttemptAt);

  const offsetMinutes = OFFSET_MINUTES_FROM_PREVIOUS[attemptNumber];
  if (!offsetMinutes) throw new Error(`Unsupported attempt number: ${attemptNumber}`);
  return nextCallingWindowOpen(timezone, new Date(previousAttemptAt.getTime() + offsetMinutes * 60_000));
}
