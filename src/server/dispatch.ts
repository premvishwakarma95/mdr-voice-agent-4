/**
 * Dispatch — same model as the IRS agent:
 *   - Attempt 1 is placed instantly from MDR's webhook (mdrWebhook.ts calls
 *     processContact for that one contact), with no calling-window gate.
 *   - The cron cycle (index.ts, every 5 min) only picks contacts that already
 *     have at least one CallAttempt — attempts 2-4 — and those are
 *     calling-window gated. Contacts with zero attempts are never picked up
 *     here (the webhook owns attempt 1).
 *   - POST /dispatch/run (x-api-key; ?dryRun=true) runs the same cron cycle.
 *
 * processContact, in order:
 *   1. MDR check-stop, fresh, every time. call_stopped=1 → mark local
 *      stop_call and skip. A FAILED check (network/422/bad shape) → skip this
 *      time only (fail safe, never dial blind), don't mark stopped.
 *   2. Next attempt number from existing CallAttempts; max MAX_CALL_ATTEMPTS (4).
 *   3. Due time: the callback time if the last attempt booked one, else the
 *      cadence. Attempt 1 and broker-named callbacks skip the window (same as
 *      IRS); attempts 2-4 on the cadence are window-gated.
 *   4. At most MAX_DIALS_PER_CYCLE real dials per cron cycle.
 *   5. Create the CallAttempt (unique index = idempotent), then dial.
 *
 * Every failure is caught per contact and recorded as a result entry — one
 * bad contact never stops the rest of the cycle.
 */
import { Router } from "express";
import { OutreachContact, CallAttempt } from "../db/models/index.js";
import { checkCallStop } from "../mdr/api.js";
import { computeAttemptSchedule, MAX_CALL_ATTEMPTS } from "./cadence.js";
import { isWithinCallingWindow } from "./callingWindow.js";
import { buildCallVariables, buildFirstMessage, buildVoicemailMessage, resolveTimezone } from "./callVariables.js";
import { createOutboundCall, toE164 } from "../vapi/calls.js";
import { env } from "../config/env.js";
import { requireApiKey } from "./auth.js";

export const dispatchRouter = Router();

type Result = Record<string, unknown>;

/** Call results that end outreach for this contact — never dial again after one. */
const FINAL_RESULTS = new Set(["rep_assigned", "declined"]);

function maxDialsPerCycle(): number {
  const n = Number(process.env.MAX_DIALS_PER_CYCLE);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

let cycleInProgress = false;

export async function runDispatchCycle(dryRun: boolean): Promise<
  { ok: true; dryRun: boolean; summary: Record<string, number>; results: Result[] } | { ok: false; error: string }
> {
  if (cycleInProgress) return { ok: false, error: "A dispatch cycle is already in progress — skipping this run." };
  cycleInProgress = true;

  try {
    let contacts;
    try {
      // Only contacts whose first attempt already happened (IRS rule) —
      // attempt 1 belongs to the webhook.
      const withAttempts = await CallAttempt.distinct("outreachContactId");
      contacts = await OutreachContact.find({ stop_call: false, outreach_contact_id: { $in: withAttempts } }).sort({ createdAt: 1 });
    } catch (err) {
      console.error("dispatch: failed to fetch outreach contacts:", err);
      return { ok: false, error: `Failed to fetch outreach contacts: ${(err as Error)?.message}` };
    }

    const results: Result[] = [];
    const budget = { remaining: maxDialsPerCycle() };
    for (const contact of contacts) {
      try {
        await processContact(contact, results, dryRun, budget);
      } catch (err) {
        console.error(`dispatch: unexpected failure for outreach contact ${contact?.outreach_contact_id}:`, err);
        results.push({ outreachContactId: contact?.outreach_contact_id, outcome: "error", error: (err as Error)?.message });
      }
    }

    const summary = results.reduce<Record<string, number>>((acc, r) => {
      const key = String(r.outcome);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
    return { ok: true, dryRun, summary, results };
  } finally {
    cycleInProgress = false;
  }
}

dispatchRouter.post("/run", requireApiKey, async (req, res) => {
  const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";
  const result = await runDispatchCycle(dryRun);
  res.status(result.ok ? 200 : 500).json(result);
});

export async function processContact(contact: any, results: Result[], dryRun: boolean, budget: { remaining: number }) {
  const id: number = contact?.outreach_contact_id;
  const push = (r: Result) => results.push({ outreachContactId: id, ...r });

  // 1. Fresh MDR stop check (never throws — see checkCallStop).
  const stop = await checkCallStop(id);
  if (stop.error) {
    push({ outcome: "check_stop_failed", error: stop.error });
    return;
  }
  if (stop.stopped) {
    if (!dryRun) {
      try {
        await OutreachContact.updateOne(
          { outreach_contact_id: id },
          { stop_call: true, stop_reason: stop.reason ?? "Stopped by MDR (check-stop)" }
        );
      } catch (err) {
        console.error(`dispatch: failed to persist stop_call for ${id}:`, err);
      }
    }
    push({ outcome: "stopped_by_mdr", reason: stop.reason });
    return;
  }

  // 2. Attempt history.
  const attempts = await CallAttempt.find({ outreachContactId: id }).sort({ attemptNumber: 1 });
  const last = attempts[attempts.length - 1];
  const nextAttemptNumber = attempts.length + 1;
  const isCallback = Boolean(last?.callbackAt);
  const cap = MAX_CALL_ATTEMPTS;

  // Safety net: a final outcome (rep assigned / declined) already
  // stops the contact in the tool handler. If that stop_call write failed,
  // never dial again anyway — and retry persisting the stop.
  const finalAttempt = attempts.find((a: any) => FINAL_RESULTS.has(a?.callResult));
  if (finalAttempt) {
    if (!dryRun) {
      try {
        await OutreachContact.updateOne(
          { outreach_contact_id: id },
          { stop_call: true, stop_reason: `Final outcome on attempt ${finalAttempt.attemptNumber}: ${finalAttempt.callResult}` }
        );
      } catch (err) {
        console.error(`dispatch: failed to persist stop_call for ${id}:`, err);
      }
    }
    push({ outcome: "already_resolved", reason: finalAttempt.callResult ?? undefined });
    return;
  }

  const lastStartedMs = last?.startedAt ? new Date(last.startedAt).getTime() : 0;
  if (last?.status === "in_progress" && !last?.endedAt && last?.vapiCallId && Date.now() - lastStartedMs < 30 * 60_000) {
    // Previous call hasn't reported its end yet — never overlap two calls.
    // Bounded to 30 min (calls cap at 15) so a lost end-of-call-report
    // can't block this contact forever.
    push({ outcome: "previous_call_in_progress", attemptNumber: last.attemptNumber });
    return;
  }
  if (nextAttemptNumber > cap) {
    if (!dryRun) {
      await OutreachContact.updateOne({ outreach_contact_id: id }, { stop_call: true, stop_reason: "Max call attempts reached" });
    }
    push({ outcome: "max_attempts_reached" });
    return;
  }

  // 3. Due time + window.
  const timezone = resolveTimezone(contact);
  let scheduledFor: Date;
  try {
    scheduledFor = isCallback
      ? (last!.callbackAt as Date)
      : computeAttemptSchedule({
          attemptNumber: nextAttemptNumber,
          timezone,
          previousAttemptAt: last?.startedAt ?? last?.createdAt,
        });
  } catch (err) {
    push({ outcome: "cadence_computation_error", attemptNumber: nextAttemptNumber, error: (err as Error)?.message });
    return;
  }

  const now = new Date();
  if (scheduledFor.getTime() > now.getTime()) {
    push({ outcome: "not_due_yet", attemptNumber: nextAttemptNumber, dueAt: scheduledFor.toISOString(), isCallback });
    return;
  }
  // Attempt 1 (instant, from the webhook) and broker-named callbacks are not
  // window-gated — same as IRS. Cadence attempts 2-4 are.
  if (nextAttemptNumber > 1 && !isCallback && !isWithinCallingWindow(timezone, now)) {
    push({ outcome: "outside_calling_window", timezone });
    return;
  }

  if (!env.vapiPhoneNumberId || !process.env.EVERLY_ASSISTANT_ID) {
    push({ outcome: "not_configured" });
    return;
  }
  const phone = toE164(contact?.phone);
  if (!phone) {
    push({ outcome: "no_valid_phone_number", phone: contact?.phone ?? null });
    return;
  }

  // 4. Per-cycle dial cap.
  if (budget.remaining <= 0) {
    push({ outcome: "deferred_dial_cap_reached", attemptNumber: nextAttemptNumber });
    return;
  }
  budget.remaining -= 1;

  if (dryRun) {
    push({ outcome: "would_dial", attemptNumber: nextAttemptNumber, scheduledFor: scheduledFor.toISOString(), isCallback });
    return;
  }

  // 5. Claim the attempt slot, then dial.
  let attempt;
  try {
    attempt = await CallAttempt.create({
      outreachContactId: id,
      attemptNumber: nextAttemptNumber,
      scheduledFor,
      isCallback,
      status: "in_progress",
      startedAt: now,
      timezone,
      phoneDialed: phone,
    });
  } catch (err: any) {
    if (err?.code === 11000) {
      push({ outcome: "attempt_slot_already_claimed" });
      return;
    }
    push({ outcome: "error", error: err?.message });
    return;
  }

  try {
    const payload = contact.toObject();
    const variableValues = buildCallVariables(payload, timezone, {
      attemptNumber: nextAttemptNumber,
      isFinalAttempt: nextAttemptNumber >= cap,
      callback: isCallback ? { reason: last?.callbackReason, pendingRep: last?.pendingRep } : null,
    });
    const call = await createOutboundCall({
      assistantId: process.env.EVERLY_ASSISTANT_ID as string,
      phoneNumberId: env.vapiPhoneNumberId,
      customerNumber: phone,
      variableValues,
      firstMessage: buildFirstMessage(payload, timezone),
      voicemailMessage: buildVoicemailMessage(payload),
    });
    attempt.vapiCallId = call.id;
    await attempt.save();
    push({ outcome: "dialed", attemptNumber: nextAttemptNumber, vapiCallId: call.id, isCallback });
  } catch (err) {
    console.error(`dispatch: failed to place Vapi call for outreach contact ${id}:`, err);
    attempt.status = "failed";
    attempt.endedAt = new Date();
    try {
      await attempt.save();
    } catch (saveErr) {
      console.error(`dispatch: also failed to mark CallAttempt ${attempt.id} failed:`, saveErr);
    }
    push({ outcome: "dial_failed", attemptNumber: nextAttemptNumber, error: (err as Error)?.message });
  }
}
