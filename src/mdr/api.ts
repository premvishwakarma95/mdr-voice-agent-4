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
