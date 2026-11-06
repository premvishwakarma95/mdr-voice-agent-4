import { twilio } from "./client.js";

interface TwilioCallResource {
  price: string | null;
  price_unit: string;
  status: string;
}

/**
 * Fetches a call's real billed price from Twilio, keyed by Twilio's own
 * Call SID (not the Vapi call id — see webhookHandlers.ts for how the two
 * are linked, via the end-of-call-report's embedded transport.callSid).
 *
 * Confirmed empirically (2026-09-06 through 2026-09-09) that Twilio's price
 * is NOT reliably available the instant a call ends — most calls settle
 * within minutes, but at least one real call was still null 3+ days later.
 * Twilio's own `price` is always a negative number (their convention for a
 * debit) — normalized to a positive amount here so callers don't have to
 * remember that quirk. Returns null (not a thrown error) when Twilio hasn't
 * computed a price yet — this is an expected, common outcome, not a
 * failure; callers should treat it as "not yet available," not an error.
 */
export async function getCallPrice(callSid: string): Promise<number | null> {
  const call = await twilio.get<TwilioCallResource>(`/Calls/${callSid}.json`);
  if (call.price === null || call.price === undefined) return null;
  const price = Number(call.price);
  return Number.isFinite(price) ? Math.abs(price) : null;
}
