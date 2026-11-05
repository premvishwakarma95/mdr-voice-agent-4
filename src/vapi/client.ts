import { env } from "../config/env.js";

const VAPI_BASE_URL = "https://api.vapi.ai";
const REQUEST_TIMEOUT_MS = 15_000;

export class VapiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`Vapi API error (${status}): ${JSON.stringify(body)}`);
  }
}

/**
 * fetch() wraps the real network-level failure (DNS lookup failure,
 * connection refused/reset, TLS failure, connect timeout, ...) in the
 * thrown error's `.cause` — the error's own `.message` is just the generic
 * "fetch failed", identical for every one of those distinct causes. See
 * src/mdr/client.ts's identical helper for the real incident (2026-09-16,
 * sibling Carrier-Representative-Agent project) that motivated capturing
 * this instead of discarding it.
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

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  // Bounded: a stalled Vapi API (e.g. mid-dial) would otherwise hang the
  // caller indefinitely rather than failing loudly.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${VAPI_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.vapiApiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Vapi API request timed out after ${REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
    }
    throw new Error(
      withCause(`Vapi API request failed: ${method} ${path} — ${(err as Error).message}`, (err as Error).cause),
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
    throw new VapiError(res.status, { nonJsonBody: text.slice(0, 500) });
  }

  if (!res.ok) {
    throw new VapiError(res.status, data);
  }

  return data as T;
}

export const vapi = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
