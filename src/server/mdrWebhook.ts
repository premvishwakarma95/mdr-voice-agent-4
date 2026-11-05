/**
 * Receiver for MDR's Agent 4 push webhook (shipment opportunity). For now it
 * only raw-captures every payload into WebhookResponse — no structured
 * extraction or dialing yet, until Agent 4's flow is built.
 *
 * Gated by the same x-api-key / TEST_DISPATCH_API_KEY shared secret Agent 2
 * uses. Send `?source=test` to tag manual test deliveries.
 */
import { Router } from "express";
import { WebhookResponse } from "../db/models/index.js";

export const mdrWebhookRouter = Router();

mdrWebhookRouter.post("/capture", async (req, res) => {
  const expectedKey = process.env.TEST_DISPATCH_API_KEY;
  if (!expectedKey || req.header("x-api-key") !== expectedKey) {
    res.status(401).json({ ok: false, error: "Missing or invalid x-api-key" });
    return;
  }

  const source = req.query.source === "test" ? "test" : "live";

  try {
    const doc = await WebhookResponse.create({ timestamp: new Date(), data: req.body ?? {}, source });
    const p = req.body?.payload;
    console.log(
      `webhook capture: saved ${doc._id} (${source}) — outreach_contact_id=${req.body?.outreach_contact_id ?? "?"}, shipment=${p?.shipment?.id ?? "?"}, shipper=${p?.shipper?.name ?? "?"}`
    );
    res.status(200).json({ ok: true, id: doc._id });
  } catch (err) {
    console.error("webhook capture: failed to write raw WebhookResponse:", err);
    res.status(500).json({ ok: false, error: "Failed to record webhook" });
  }
});
