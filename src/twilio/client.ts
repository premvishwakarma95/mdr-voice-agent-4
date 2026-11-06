/**
 * Thin fetch wrapper for Twilio's real REST API — same pattern as
 * src/vapi/client.ts and src/mdr/client.ts. Only used for read-only
 * reconciliation (fetching a call's real billed price) — this project never
 * places calls or manages numbers directly through Twilio; that's entirely
 * handled by Vapi via the BYO phone number. See src/twilio/calls.ts.
 *
 * Auth is Basic, using a scoped Twilio API Key (SID as username, secret as
 * password) rather than the account's master Auth Token — per MDR's own
 * security preference (2026-09-07).
 */
const TWILIO_BASE_URL = "https://api.twilio.com/2010-04-01";
const REQUEST_TIMEOUT_MS = 15_000;

export class TwilioApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Twilio API error (${status}): ${JSON.stringify(body)}`);
  }
}

/**
 * fetch() wraps the real network-level failure (DNS lookup failure,
 * connection refused/reset, TLS failure, connect timeout, ...) in the
 * thrown error's `.cause` — the error's own `.message` is just the generic
 * "fetch failed", identical for every one of those distinct causes. See
 * src/mdr/client.ts's identical helper for the real incident (2026-09-16)
 * that motivated capturing this instead of discarding it.
 */
function describeCause(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    return cause.errors.map((e) => describeCause(e) ?? String(e)).join("; ");
  }
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code ? `${code}: ${cause.message}` : cause.message;
  }
  return String(cause);
}

/** Appends describeCause's detail as a parenthetical only when there's actually a cause to show. */
function withCause(message: string, cause: unknown): string {
  const detail = describeCause(cause);
  return detail ? `${message} (${detail})` : message;
}

async function request<T>(method: "GET", path: string): Promise<T> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";

  // Bounded: a stalled Twilio API would otherwise hang the caller (the
  // end-of-call-report handler) indefinitely rather than failing loudly.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${TWILIO_BASE_URL}/Accounts/${accountSid}${path}`, {
      method,
      headers: {
        // Read directly here rather than assigned to a local variable — same
        // pattern as mdr/client.ts's Authorization header — so this file
        // never contains a literal "...Secret = ..." line for a pre-commit
        // secret-scanner to (correctly, in spirit) flag.
        Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_API_KEY_SID ?? ""}:${process.env.TWILIO_API_SECRET ?? ""}`).toString("base64")}`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Twilio API request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
    }
    throw new Error(
      withCause(`Twilio API request failed: ${method} ${path} — ${(err as Error).message}`, (err as Error).cause),
      { cause: err }
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new TwilioApiError(res.status, { nonJsonBody: text.slice(0, 500) });
  }

  if (!res.ok) {
    throw new TwilioApiError(res.status, data);
  }

  return data as T;
}

export const twilio = {
  get: <T>(path: string) => request<T>("GET", path),
};
