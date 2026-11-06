/**
 * Shared-secret checks, timing-safe (plain !== leaks length/prefix timing).
 */
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Requires header x-api-key === TEST_DISPATCH_API_KEY (same key Agent 2 staging uses). */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!safeEqual(req.header("x-api-key"), process.env.TEST_DISPATCH_API_KEY)) {
    res.status(401).json({ ok: false, error: "Missing or invalid x-api-key" });
    return;
  }
  next();
}

/**
 * Vapi server-message auth. Only enforced when VAPI_SERVER_SECRET is set —
 * assistant:create pushes the same value to Vapi as server.secret, and Vapi
 * then sends it as the x-vapi-secret header on every webhook.
 */
export function requireVapiSecret(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.VAPI_SERVER_SECRET;
  if (expected && !safeEqual(req.header("x-vapi-secret"), expected)) {
    res.status(401).json({ ok: false, error: "Invalid Vapi secret" });
    return;
  }
  next();
}
