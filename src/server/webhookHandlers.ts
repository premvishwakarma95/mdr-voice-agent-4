/**
 * Handles Vapi's two server message types (same structure as Agent 2):
 *  - "tool-calls": the agent invoked a function tool mid-call
 *  - "end-of-call-report": the call ended — store artifacts, then report the
 *    outcome to MDR's /shipment-opportunity/result (once per attempt)
 *
 * Context (outreach contact, attempt) is never taken from the LLM — it's
 * resolved from message.call.id → CallAttempt.vapiCallId, same as Agent 2.
 */
import type { HydratedDocument } from "mongoose";
import { CallAttempt, OutreachContact } from "../db/models/index.js";
import { createSalesRepresentative, submitCallResult } from "../mdr/api.js";
import { applyCallOutcome, buildResultMessage, mapToMdrCallStatus } from "./callOutcome.js";
import { MAX_CALL_ATTEMPTS } from "./cadence.js";
import { isValidTimezone, wallClockToUtc } from "./callingWindow.js";
import { getCallPrice } from "../twilio/calls.js";
import type { MdrSalesRep } from "./callVariables.js";
import { buildPlayableRecordingUrl } from "./recordings.js";

type ToolCall = { id: string; name: string; parameters: Record<string, any> };
type Ctx = { attempt: HydratedDocument<any>; contact: HydratedDocument<any> | null };

export async function handleToolCalls(toolCallList: ToolCall[], vapiCallId: string) {
  const attempt = vapiCallId ? await CallAttempt.findOne({ vapiCallId }) : null;
  if (!attempt) {
    console.warn(`tool-calls: no CallAttempt for vapiCallId ${vapiCallId}`);
    return toolCallList.map((call) => ({
      toolCallId: call?.id,
      name: call?.name,
      result: JSON.stringify({ ok: false, error: "Unknown call — no matching CallAttempt" }),
    }));
  }
  const contact = await OutreachContact.findOne({ outreach_contact_id: attempt.outreachContactId });
  const ctx: Ctx = { attempt, contact };

  const results = [];
  for (const call of toolCallList) {
    try {
      const result = await dispatchTool(call?.name, call?.parameters ?? {}, ctx);
      results.push({ toolCallId: call?.id, name: call?.name, result: JSON.stringify(result) });
    } catch (err) {
      console.error(`tool ${call?.name} failed for vapiCallId ${vapiCallId}:`, err);
      results.push({
        toolCallId: call?.id,
        name: call?.name,
        result: JSON.stringify({ ok: false, error: (err as Error)?.message ?? String(err) }),
      });
    }
  }
  return results;
}

async function dispatchTool(name: string, params: Record<string, any>, ctx: Ctx) {
  switch (name) {
    case "assign_existing_rep":
      return assignExistingRep(params, ctx);
    case "create_new_rep":
      return createNewRep(params, ctx);
    case "schedule_callback":
      return scheduleCallback(params, ctx);
    case "log_decline":
      return logDecline(params, ctx);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------- helpers ----------

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

const norm = (v: unknown) => str(v).toLowerCase().replace(/\s+/g, " ");

/**
 * Finds the broker's existing rep(s) for a spoken name: exact full-name match
 * first, else first-name match; then narrowed by email if given.
 */
export function matchReps(reps: MdrSalesRep[], name: string, email?: string): MdrSalesRep[] {
  const target = norm(name);
  if (!target) return [];
  const list = (reps ?? []).filter((r) => str(r?.name));
  let matches = list.filter((r) => norm(r.name) === target);
  if (matches.length === 0) {
    const first = target.split(" ")[0];
    matches = list.filter((r) => norm(r.name).split(" ")[0] === first);
  }
  if (matches.length > 1 && str(email)) {
    const byEmail = matches.filter((r) => norm(r.email) === norm(email));
    if (byEmail.length > 0) matches = byEmail;
  }
  return matches;
}

async function stopContact(ctx: Ctx, reason: string) {
  try {
    await OutreachContact.updateOne({ outreach_contact_id: ctx.attempt.outreachContactId }, { stop_call: true, stop_reason: reason });
  } catch (err) {
    console.error(`failed to set stop_call for outreach contact ${ctx.attempt.outreachContactId}:`, err);
  }
}

async function submitRep(
  ctx: Ctx,
  rep: { name: string; email: string; phone: string; taiSalesRepId: string; isNewRep: boolean; mdrSalesRepId?: number }
) {
  const { attempt } = ctx;
  attempt.assignedRep = rep;
  try {
    await createSalesRepresentative({
      outreachContactId: attempt.outreachContactId,
      name: rep.name,
      email: rep.email,
      phone: rep.phone,
      taiSalesRepId: rep.taiSalesRepId,
    });
  } catch (err) {
    // The whole point is MDR's record — never report success that didn't happen.
    attempt.mdrRepSubmission = "failed";
    attempt.mdrRepError = (err as Error)?.message;
    await attempt.save();
    console.error(`sales-representative submit failed for ${attempt.outreachContactId}:`, err);
    return { ok: false, error: "MDR did not accept the sales representative assignment" };
  }
  attempt.mdrRepSubmission = "submitted";
  attempt.callResult = "rep_assigned";
  attempt.pendingRep = undefined;
  await attempt.save();
  await stopContact(ctx, "Sales representative assigned");
  return { ok: true, assigned: rep.name };
}

// ---------- tools ----------

async function assignExistingRep(params: any, ctx: Ctx) {
  const reps: MdrSalesRep[] = ctx.contact?.broker_sales_reps ?? [];
  const matches = matchReps(reps, params?.repName, params?.repEmail);

  if (matches.length === 0) {
    return { ok: false, error: "no_match", message: "No existing sales representative matches that name — treat as a new rep." };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: "multiple_matches",
      message: "More than one rep matches — read each one's email and phone and ask which is correct, then call again with repEmail.",
      candidates: matches.map((r) => ({ name: r?.name, email: r?.email ?? null, phone: r?.phone ?? null })),
    };
  }

  const rep = matches[0];
  const taiSalesRepId = str(rep?.sales_rep_id) || str(params?.taiSalesRepId);
  if (!taiSalesRepId) {
    return {
      ok: false,
      error: "missing_tai_id",
      message: "This rep has no TAI Sales Representative ID on file. Ask the broker for it; if they don't have it, explain why it's needed and offer a callback.",
    };
  }
  return submitRep(ctx, {
    name: str(rep?.name),
    email: str(rep?.email),
    phone: str(rep?.phone),
    taiSalesRepId,
    isNewRep: false,
    mdrSalesRepId: rep?.id,
  });
}

async function createNewRep(params: any, ctx: Ctx) {
  const name = str(params?.name);
  const email = str(params?.email);
  const phone = str(params?.phone);
  const taiSalesRepId = str(params?.taiSalesRepId);
  const missing = [!name && "name", !email && "email", !phone && "phone", !taiSalesRepId && "taiSalesRepId"].filter(Boolean);
  if (missing.length > 0) {
    return { ok: false, error: "missing_fields", missing };
  }
  return submitRep(ctx, { name, email, phone, taiSalesRepId, isNewRep: true });
}

async function scheduleCallback(params: any, { attempt, contact }: Ctx) {
  // Interpreted as wall-clock time in the zone this attempt used — never any
  // offset the LLM embedded (same rule as Agent 2's wallClockToUtc).
  const raw = str(params?.callbackDateTime);
  let when: Date;
  try {
    when = isValidTimezone(attempt.timezone) ? wallClockToUtc(raw, attempt.timezone) : new Date(raw);
  } catch (err) {
    throw new Error(`Invalid callbackDateTime ${JSON.stringify(raw)}: ${(err as Error)?.message}`);
  }
  if (Number.isNaN(when.getTime())) throw new Error(`Invalid callbackDateTime ${JSON.stringify(raw)}`);

  // Sanity bounds (Agent 2 had none — a misread year/AM-PM would dial
  // immediately or at night): must be in the future and within 14 days.
  const now = Date.now();
  if (when.getTime() < now - 5 * 60_000) {
    return { ok: false, error: "callback_time_in_past", message: "That time has already passed — re-check against currentTime and ask again." };
  }
  if (when.getTime() > now + 14 * 24 * 60 * 60_000) {
    return { ok: false, error: "callback_too_far", message: "Callbacks can be at most 14 days out — ask for an earlier time." };
  }

  attempt.callResult = "callback";
  attempt.callbackAt = when;
  attempt.callbackReason = str(params?.reason) || undefined;
  if (str(params?.pendingRepName)) {
    // Existing rep = exact full-name match on the broker's list (narrowed by
    // email if two share the name). Deliberately NOT matchReps' first-name
    // fallback — a new "John Smith" must not be mistaken for "John Bellevaro".
    const reps: MdrSalesRep[] = contact?.broker_sales_reps ?? [];
    let existing = reps.filter((r) => str(r?.name) && norm(r.name) === norm(params.pendingRepName));
    if (existing.length > 1 && str(params?.pendingRepEmail)) {
      existing = existing.filter((r) => norm(r?.email) === norm(params.pendingRepEmail));
    }
    const onFile = existing.length === 1 ? existing[0] : null;
    attempt.pendingRep = {
      name: onFile ? str(onFile.name) : str(params.pendingRepName),
      email: (onFile ? str(onFile?.email) : "") || str(params?.pendingRepEmail) || undefined,
      phone: (onFile ? str(onFile?.phone) : "") || str(params?.pendingRepPhone) || undefined,
      isExistingRep: Boolean(onFile),
    };
  }
  await attempt.save();
  return { ok: true, callbackAt: when.toISOString() };
}

async function logDecline(params: any, ctx: Ctx) {
  ctx.attempt.callResult = "declined";
  ctx.attempt.declineReason = str(params?.reason) || "other";
  ctx.attempt.declineNote = str(params?.note) || undefined;
  await ctx.attempt.save();
  await stopContact(ctx, `Declined: ${ctx.attempt.declineReason}`);
  return { ok: true };
}

// ---------- end of call ----------

export async function handleEndOfCallReport(message: any) {
  const vapiCallId = message?.call?.id;
  const attempt = vapiCallId ? await CallAttempt.findOne({ vapiCallId }) : null;
  if (!attempt) {
    console.warn(`end-of-call-report: no CallAttempt for vapiCallId ${vapiCallId} — ignoring`);
    return;
  }

  // Store the same playable link we send MDR (signed /recordings proxy), not
  // Vapi's private R2 path — that one is kept separately for debugging only.
  const rawRecordingUrl: string | undefined = message?.artifact?.recording?.stereoUrl ?? message?.artifact?.recordingUrl;
  attempt.rawRecordingUrl = rawRecordingUrl;
  applyCallOutcome(attempt, {
    endedReason: message?.endedReason,
    transcript: message?.artifact?.transcript,
    recordingUrl: rawRecordingUrl ? buildPlayableRecordingUrl(vapiCallId) : undefined,
    summary: message?.summary ?? message?.analysis?.summary,
    vapiStartedAt: message?.startedAt,
    vapiEndedAt: message?.endedAt,
  });
  attempt.vapiCost = typeof message?.cost === "number" ? message.cost : undefined;

  const callSid = message?.call?.transport?.callSid;
  if (callSid) {
    attempt.twilioCallSid = callSid;
    try {
      attempt.twilioCost = (await getCallPrice(callSid)) ?? undefined;
    } catch (err) {
      console.error(`end-of-call-report: Twilio price lookup failed for ${callSid}:`, err);
    }
  }
  await attempt.save();

  // Report to MDR once per attempt (a retried webhook must not double-report).
  if (!attempt.mdrResultSubmittedAt) {
    const callStatus = mapToMdrCallStatus(attempt);
    if (callStatus) {
      try {
        await submitCallResult({
          outreachContactId: attempt.outreachContactId,
          voiceCallId: vapiCallId,
          callStatus,
          message: buildResultMessage(attempt),
          durationSeconds: attempt.durationSeconds ?? 0,
          // Same tracking fields IRS sends in its call-log data{}.
          tracking: {
            direction: "outbound",
            started_at: message?.startedAt,
            ended_at: message?.endedAt,
            // Our playable proxy link (same value stored on the attempt), not
            // Vapi's private R2 path (see recordings.ts).
            recording_url: attempt.recordingUrl,
            transcript: attempt.transcript,
            provider: "vapi",
            attempt_number: attempt.attemptNumber,
            call_result: attempt.callResult,
            ended_reason: attempt.endedReason,
            vapi_cost: attempt.vapiCost,
            twilio_cost: attempt.twilioCost,
            total_cost:
              typeof attempt.vapiCost === "number" && typeof attempt.twilioCost === "number"
                ? attempt.vapiCost + attempt.twilioCost
                : undefined,
          },
        });
        attempt.mdrResultStatus = callStatus;
        attempt.mdrResultSubmittedAt = new Date();
        attempt.mdrResultError = undefined;
        console.log(`end-of-call-report: reported ${callStatus} to MDR for outreach contact ${attempt.outreachContactId}`);
      } catch (err) {
        attempt.mdrResultError = (err as Error)?.message;
        console.error(`end-of-call-report: MDR /result failed for outreach contact ${attempt.outreachContactId}:`, err);
      }
      await attempt.save();
    } else {
      console.log(
        `end-of-call-report: no MDR status for outreach contact ${attempt.outreachContactId} (status=${attempt.status}, callResult=${attempt.callResult}) — not reported`
      );
    }
  }

  // 4 attempts used (IRS rule) → done with this contact.
  if (attempt.attemptNumber >= MAX_CALL_ATTEMPTS) {
    await stopContact({ attempt, contact: null }, "Max call attempts reached");
  }
}
