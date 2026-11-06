/**
 * Playable call-recording links for MDR — same purpose as the IRS agent's
 * recordings.ts. Vapi's raw recording URL (artifact.recording.stereoUrl) is a
 * private R2 path nobody can play without credentials; Vapi's own
 * GET /call/{id}/stereo-recording (private API key) 302s to a short-lived
 * signed URL. This route makes that call server-side and streams the audio,
 * so MDR gets a plain link that works in a browser or an <audio> tag.
 *
 * Two deliberate differences from IRS:
 *  - The link carries a per-recording signature (?sig=HMAC-SHA256 of the call
 *    id, keyed with TEST_DISPATCH_API_KEY) instead of the master key itself.
 *    IRS's ?key= link exposes the webhook/dispatch key to anyone who can see
 *    a recording URL in MDR's dashboard; a signature only unlocks that one
 *    recording and can't be reused for anything else.
 *  - vapiCallId must be a UUID. IRS interpolates it into the Vapi URL
 *    unchecked, so an encoded "../" could make the proxy call other Vapi
 *    endpoints with our private API key.
 *
 * Add &download=1 to get a Content-Disposition: attachment response.
 */
import { createHmac } from "node:crypto";
import { Router } from "express";
import { Readable } from "node:stream";
import { env } from "../config/env.js";
import { safeEqual } from "./auth.js";

export const recordingsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function signRecording(vapiCallId: string): string | null {
  const secret = process.env.TEST_DISPATCH_API_KEY;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`recording:${vapiCallId}`).digest("hex");
}

/**
 * Public, playable URL for a call's recording, on the same public host Vapi
 * already calls back into (ORCHESTRATION_WEBHOOK_URL's origin). undefined if
 * that URL or the signing key isn't configured.
 */
export function buildPlayableRecordingUrl(vapiCallId: string): string | undefined {
  const sig = signRecording(vapiCallId);
  const base = process.env.ORCHESTRATION_WEBHOOK_URL;
  if (!sig || !base || !UUID_RE.test(vapiCallId)) return undefined;
  try {
    return `${new URL(base).origin}/recordings/${vapiCallId}?sig=${sig}`;
  } catch {
    return undefined;
  }
}

recordingsRouter.get("/:vapiCallId", async (req, res) => {
  const { vapiCallId } = req.params;
  if (!UUID_RE.test(vapiCallId ?? "")) {
    res.status(400).json({ ok: false, error: "Invalid call id" });
    return;
  }
  const expected = signRecording(vapiCallId);
  if (!expected || !safeEqual(String(req.query.sig ?? ""), expected)) {
    res.status(401).json({ ok: false, error: "Missing or invalid signature" });
    return;
  }

  let vapiResponse;
  try {
    vapiResponse = await fetch(`${process.env.VAPI_API_BASE_URL ?? "https://api.vapi.ai"}/call/${vapiCallId}/stereo-recording`, {
      headers: { Authorization: `Bearer ${env.vapiApiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(`recordings: failed to reach Vapi for call ${vapiCallId}:`, err);
    res.status(502).json({ ok: false, error: "Failed to reach Vapi" });
    return;
  }

  if (!vapiResponse.ok || !vapiResponse.body) {
    console.error(`recordings: Vapi returned ${vapiResponse.status} for call ${vapiCallId}`);
    res.status(vapiResponse.status === 404 ? 404 : 502).json({ ok: false, error: `Vapi returned ${vapiResponse.status}` });
    return;
  }

  res.setHeader("Content-Type", vapiResponse.headers.get("content-type") ?? "audio/wav");
  if (req.query.download) {
    res.setHeader("Content-Disposition", `attachment; filename="${vapiCallId}.wav"`);
  }
  Readable.fromWeb(vapiResponse.body as any)
    .on("error", (err) => {
      console.error(`recordings: stream error for call ${vapiCallId}:`, err);
      res.destroy(err);
    })
    .pipe(res);
});
