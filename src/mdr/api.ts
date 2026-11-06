/**
 * MDR Agent 4 endpoints (see MDR_Agent_4_API_Documentation.docx).
 */
import { mdrPost } from "./client.js";

export interface CallStopStatus {
  outreachContactId: number;
  /** true → do NOT call this contact. */
  stopped: boolean;
  reason: string | null;
  /** Set when the check itself failed (network error, bad response) — stopped is forced true. */
  error?: string;
}

/** MDR's fixed call_status vocabulary for /shipment-opportunity/result (per the Agent 4 API doc). */
export type MdrCallStatus =
  | "NO_ANSWER"
  | "LEFT_VOICEMAIL"
  | "EMAIL_REQUESTED"
  | "ACCEPTED"
  | "DECLINED"
  | "CALL_DROPPED";

/**
 * POST /voice/shipment-opportunity/sales-representative
 * Assigns a sales rep to this outreach contact's shipper. Throws on failure —
 * the caller (the assign tool) must surface a failure to the agent, never
 * report success that didn't happen.
 */
export async function createSalesRepresentative(params: {
  outreachContactId: number;
  name: string;
  email: string;
  phone: string;
  taiSalesRepId: string;
}): Promise<unknown> {
  return mdrPost("/voice/shipment-opportunity/sales-representative", {
    outreach_contact_id: params.outreachContactId,
    name: params.name,
    email: params.email,
    phone: params.phone,
    tai_sales_rep_id: params.taiSalesRepId,
  });
}

/** Extra tracking fields sent inside result{} — same set the IRS agent sends in its call-log data{}. */
export interface CallResultTracking {
  direction?: "outbound" | null;
  started_at?: string | null;
  ended_at?: string | null;
  recording_url?: string | null;
  transcript?: string | null;
  provider?: "vapi" | null;
  attempt_number?: number | null;
  call_result?: string | null;
  ended_reason?: string | null;
  vapi_cost?: number | null;
  twilio_cost?: number | null;
  total_cost?: number | null;
}

/**
 * POST /voice/shipment-opportunity/result — sent after EVERY ended call so
 * MDR can track all of them (same role as IRS's /voice/call-logs).
 * The doc only defines result.message + result.duration; the tracking fields
 * (recording_url, transcript, timestamps, costs, ...) ride along inside
 * result{} like IRS's data{} — MDR to confirm they store them.
 * duration is whole seconds (doc example: 120; unit unspecified by MDR).
 * Throws on failure; the end-of-call handler catches and logs it.
 */
export async function submitCallResult(params: {
  outreachContactId: number;
  voiceCallId: string;
  callStatus: MdrCallStatus;
  message: string;
  durationSeconds: number;
  tracking?: CallResultTracking;
}): Promise<unknown> {
  // Drop undefined so MDR never receives explicit nulls for fields we don't have.
  const tracking = Object.fromEntries(Object.entries(params.tracking ?? {}).filter(([, v]) => v !== undefined && v !== null));
  return mdrPost("/voice/shipment-opportunity/result", {
    outreach_contact_id: params.outreachContactId,
    voice_call_id: params.voiceCallId,
    call_status: params.callStatus,
    result: { message: params.message, duration: params.durationSeconds, ...tracking },
  });
}

/**
 * POST /voice/shipment-opportunity/check-stop
 * Real response: {"success":true,"data":{"outreach_contact_id":11,"call_stopped":1,"call_stop_reason":null}}
 * call_stopped === 1 means no need to call (confirmed rule, 2026-11-04).
 * An unknown id returns HTTP 422 "The selected outreach contact id is invalid."
 *
 * Never throws: any failure (network error, non-2xx, missing fields) is
 * returned as stopped: true with `error` set — fail safe, never dial blind.
 * Must be checked right before every dial.
 */
export async function checkCallStop(outreachContactId: number): Promise<CallStopStatus> {
  try {
    const res = await mdrPost<{
      success?: boolean;
      data?: { outreach_contact_id?: number; call_stopped?: number | boolean; call_stop_reason?: string | null };
    }>("/voice/shipment-opportunity/check-stop", { outreach_contact_id: outreachContactId });

    const callStopped = res?.data?.call_stopped;
    if (!res?.success || callStopped === undefined || callStopped === null) {
      const error = `unexpected check-stop response: ${JSON.stringify(res)}`;
      console.error(`check-stop (${outreachContactId}): ${error}`);
      return { outreachContactId, stopped: true, reason: null, error };
    }

    return {
      outreachContactId: res?.data?.outreach_contact_id ?? outreachContactId,
      stopped: Number(callStopped) === 1,
      reason: res?.data?.call_stop_reason ?? null,
    };
  } catch (err: any) {
    const error = err?.message ?? String(err);
    console.error(`check-stop (${outreachContactId}) failed: ${error}`);
    return { outreachContactId, stopped: true, reason: null, error };
  }
}
