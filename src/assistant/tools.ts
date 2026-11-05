/**
 * Function-calling tools for Agent 4.
 *
 * TODO: Agent 4's own tools go here (e.g. save sales rep → MDR
 * /shipment-opportunity/sales-representative, call result → /result) once
 * the call flow is confirmed. Same rules as Agent 2: never expose internal
 * ids (outreach_contact_id etc.) as LLM-supplied parameters — the server
 * resolves them from message.call.id.
 */

export const ORCHESTRATION_WEBHOOK_URL =
  process.env.ORCHESTRATION_WEBHOOK_URL ?? "http://localhost:3003/vapi/tool-calls";

export const TOOLS = [
  // Vapi's built-in call-termination tool — no server URL, handled natively.
  { type: "endCall" as const },
];
