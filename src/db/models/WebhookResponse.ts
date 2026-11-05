/**
 * Raw-capture store for every inbound MDR webhook payload (Agent 4 —
 * shipment opportunity: payload.shipper / payload.shipment /
 * payload.broker_sales_reps). Stored as-is, unparsed, so real traffic can be
 * inspected before structured models get built against the confirmed shape.
 * Same model as Agent 2's WebhookResponse.
 */
import { Schema, model } from "mongoose";

const webhookResponseSchema = new Schema({
  timestamp: { type: Date, required: true, default: Date.now },
  data: { type: Schema.Types.Mixed, required: true },
  // "live" for real MDR deliveries; "test" lets manual test sends be told
  // apart in this shared audit store.
  source: { type: String, enum: ["live", "test"], required: true, default: "live" },
});

export const WebhookResponse = model("WebhookResponse", webhookResponseSchema);
