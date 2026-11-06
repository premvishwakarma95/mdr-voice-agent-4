/**
 * Receiver for MDR's Agent 4 push webhook (shipment opportunity).
 *
 * 1. Raw-captures every payload into WebhookResponse first (audit safety
 *    net — never lost even if extraction below has a bug), then 200s.
 * 2. Upserts an OutreachContact keyed on outreach_contact_id.
 * 3. Immediately runs dispatch.ts's processContact for that contact (IRS
 *    model): check-stop → place attempt 1 right now → store the CallAttempt.
 *    No calling-window gate for attempt 1. Attempts 2-4 come from cron.
 *    A re-sent webhook for a contact already in progress just goes through
 *    the same checks (cadence/in-progress guard), so it never double-dials.
 *
 * Shape tolerance: MDR's doc wraps the data in `payload`, but the first real
 * delivery (2026-11-05) sent it flat at the top level — both are accepted.
 * outreach_contact_id is read from the top level or inside payload. That
 * first real delivery had NO outreach_contact_id at all; without it nothing
 * can be dialed or reported (every MDR endpoint needs it), so such a payload
 * is raw-captured and logged, but not turned into a contact.
 *
 * Gated by x-api-key = TEST_DISPATCH_API_KEY (same key as Agent 2 staging).
 * Send ?source=test to tag manual test deliveries.
 */
import { Router } from "express";
import { OutreachContact, WebhookResponse } from "../db/models/index.js";
import { requireApiKey } from "./auth.js";
import { processContact, isMdrStop } from "./dispatch.js";

export const mdrWebhookRouter = Router();

/** Extracts the contact fields from either the flat or the payload-wrapped shape. */
export function extractOpportunity(body: any) {
  const p = body?.payload && typeof body.payload === "object" ? body.payload : body;
  const rawId = body?.outreach_contact_id ?? p?.outreach_contact_id;
  const outreachContactId = Number(rawId);
  return {
    outreachContactId: rawId !== undefined && rawId !== null && Number.isFinite(outreachContactId) ? outreachContactId : null,
    fields: {
      shipper: p?.shipper ?? null,
      shipment: p?.shipment ?? null,
      broker_sales_reps: Array.isArray(p?.broker_sales_reps) ? p.broker_sales_reps : [],
      company_name: p?.company_name ?? null,
      contact_name: p?.contact_name ?? null,
      email: p?.email ?? null,
      phone: p?.phone ?? null,
      ...(p?.timezone ? { timezone: p.timezone } : {}),
    },
  };
}

mdrWebhookRouter.post("/capture", requireApiKey, async (req, res) => {
  const source = req.query.source === "test" ? "test" : "live";

  let docId;
  try {
    const doc = await WebhookResponse.create({ timestamp: new Date(), data: req.body ?? {}, source });
    docId = doc._id;
  } catch (err) {
    console.error("webhook capture: failed to write raw WebhookResponse:", err);
    res.status(500).json({ ok: false, error: "Failed to record webhook" });
    return;
  }
  res.status(200).json({ ok: true, id: docId });

  const { outreachContactId, fields } = extractOpportunity(req.body);
  console.log(
    `webhook capture: saved ${docId} (${source}) — outreach_contact_id=${outreachContactId ?? "MISSING"}, shipment=${fields.shipment?.id ?? "?"}, shipper=${fields.shipper?.name ?? "?"}`
  );

  if (outreachContactId === null) {
    console.warn(`webhook capture: ${docId} has no outreach_contact_id — stored raw only, nothing will be dialed`);
    return;
  }

  try {
    // $set refreshes MDR's data; stop_call is only ever set on insert, so a
    // re-sent webhook can never un-stop a contact we've already finished with.
    await OutreachContact.updateOne(
      { outreach_contact_id: outreachContactId },
      { $set: fields, $setOnInsert: { stop_call: false } },
      { upsert: true }
    );
    console.log(`webhook capture: upserted outreach contact ${outreachContactId}`);
  } catch (err) {
    console.error(`webhook capture: failed to upsert outreach contact ${outreachContactId}:`, err);
    return;
  }

  // Instant attempt 1 (eligibility check + dial + CallAttempt), same as IRS.
  try {
    const contact = await OutreachContact.findOne({ outreach_contact_id: outreachContactId });
    // Our own final stops (rep assigned, declined, max attempts) are permanent.
    // A stop that came from MDR's check-stop is re-checked: MDR may have
    // reset the contact before re-sending the webhook.
    if (!contact || (contact.stop_call && !isMdrStop(contact.stop_reason))) {
      console.log(`webhook capture: outreach contact ${outreachContactId} is stopped locally (${contact?.stop_reason ?? "no contact"}) — not dialing`);
      return;
    }
    const results: Record<string, unknown>[] = [];
    await processContact(contact, results, false, { remaining: 1 }, { fromWebhook: true });
    console.log(`webhook capture: dispatch result for outreach contact ${outreachContactId}:`, results);
  } catch (err) {
    console.error(`webhook capture: dispatch failed for outreach contact ${outreachContactId}:`, err);
  }
});
