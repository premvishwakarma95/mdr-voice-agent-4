import { vapi } from "./client.js";

/**
 * Places a real outbound call. firstMessage/voicemailMessage are per-call
 * overrides built server-side (callVariables.ts) — a non-empty firstMessage
 * override IS spoken even under firstMessageMode "assistant-waits-for-user"
 * (confirmed on Agent 2, 2026-08-21).
 */
export async function createOutboundCall(params: {
  assistantId: string;
  phoneNumberId: string;
  customerNumber: string;
  variableValues: Record<string, string | number | boolean>;
  firstMessage?: string;
  voicemailMessage?: string;
}) {
  return vapi.post<{ id: string }>("/call", {
    assistantId: params.assistantId,
    phoneNumberId: params.phoneNumberId,
    customer: { number: params.customerNumber },
    assistantOverrides: {
      variableValues: params.variableValues,
      ...(params.firstMessage ? { firstMessage: params.firstMessage } : {}),
      ...(params.voicemailMessage ? { voicemailMessage: params.voicemailMessage } : {}),
    },
  });
}

/**
 * Best-effort E.164 for Vapi: keeps a leading "+" number as-is; a bare
 * 10-digit number is assumed US (+1); an 11-digit number starting with 1
 * gets "+". Anything else is returned null (not dialed) rather than guessed.
 */
export function toE164(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
