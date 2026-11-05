/**
 * Thin fetch wrapper for MDR's Voice API (same pattern as Agent 2):
 * Bearer MDR_API_KEY against MDR_API_BASE_URL. Throws on non-2xx with the
 * status + body, and surfaces the real network cause instead of "fetch failed".
 */
import "dotenv/config";

export class MdrApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown
  ) {
    super(message);
  }
}

export async function mdrPost<T = any>(path: string, body: unknown): Promise<T> {
  const base = process.env.MDR_API_BASE_URL;
  const key = process.env.MDR_API_KEY;
  if (!base || !key) throw new Error("Missing MDR_API_BASE_URL or MDR_API_KEY");

  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err: any) {
    throw new Error(`MDR POST ${path} failed: ${err?.cause?.message ?? err?.message ?? err}`);
  }

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body, keep raw text
  }
  if (!res.ok) {
    throw new MdrApiError(`MDR POST ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`, res.status, parsed);
  }
  return parsed as T;
}
