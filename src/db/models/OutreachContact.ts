/**
 * One record per MDR outreach contact — the broker employee Agent 4 calls to
 * get a sales rep assigned to a new shipper. Upserted from MDR's
 * shipment-opportunity webhook (src/server/mdrWebhook.ts), keyed on
 * outreach_contact_id (the id every MDR Agent 4 endpoint takes).
 *
 * Payload fields mirror MDR's webhook names as-is (shipper, shipment,
 * broker_sales_reps, contact_name, ...) and are stored as Mixed — MDR's shape
 * is still settling, and the raw copy in WebhookResponse remains the audit
 * trail either way.
 *
 * stop_call is OUR local "don't dial again" flag (rep assigned, declined,
 * email requested, max attempts, or MDR's check-stop said stop). The webhook
 * upsert only ever sets it on insert ($setOnInsert) — a re-sent webhook must
 * never un-stop a contact (a real bug in Agent 2's carrier upsert).
 */
import { Schema, model } from "mongoose";

const outreachContactSchema = new Schema(
  {
    outreach_contact_id: { type: Number, required: true, unique: true },

    shipper: { type: Schema.Types.Mixed },
    shipment: { type: Schema.Types.Mixed },
    broker_sales_reps: { type: [Schema.Types.Mixed], default: [] },
    company_name: String,
    contact_name: String,
    email: String,
    phone: String,
    // Optional — not in MDR's payload today; used for the calling window if
    // MDR ever sends one, otherwise CALLING_TIMEZONE from env applies.
    timezone: String,

    stop_call: { type: Boolean, default: false, index: true },
    stop_reason: String,
  },
  { timestamps: true }
);

export const OutreachContact = model("OutreachContact", outreachContactSchema);
