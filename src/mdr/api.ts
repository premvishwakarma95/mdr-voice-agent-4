/**
 * MDR Agent 4 endpoints (see MDR_Agent_4_API_Documentation.docx).
 */
import { mdrPost } from "./client.js";

export interface CallStopStatus {
  outreachContactId: number;
  /** true → do NOT call this contact. */
  stopped: boolean;
  reason: string | null;
}

/**
 * POST /voice/shipment-opportunity/check-stop
 * Real response: {"success":true,"data":{"outreach_contact_id":11,"call_stopped":1,"call_stop_reason":null}}
 * call_stopped === 1 means no need to call (confirmed rule, 2026-11-04).
 * An unknown id returns HTTP 422 "The selected outreach contact id is invalid." — that throws.
 *
 * Must be checked right before every dial. Callers should treat a thrown
 * error as "don't call" (fail safe) rather than dialing blind.
 */
export async function checkCallStop(outreachContactId: number): Promise<CallStopStatus> {
  const res = await mdrPost<{
    success: boolean;
    data?: { outreach_contact_id: number; call_stopped: number | boolean; call_stop_reason: string | null };
  }>("/voice/shipment-opportunity/check-stop", { outreach_contact_id: outreachContactId });

  if (!res?.success || !res.data) {
    throw new Error(`check-stop: unexpected response for ${outreachContactId}: ${JSON.stringify(res)}`);
  }
  return {
    outreachContactId: res.data.outreach_contact_id,
    stopped: Number(res.data.call_stopped) === 1,
    reason: res.data.call_stop_reason ?? null,
  };
}
