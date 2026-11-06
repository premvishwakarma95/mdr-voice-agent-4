/**
 * Function-calling tools for Agent 4 (Everly — sales rep assignment).
 * Same rules as Agent 2: no internal ids (outreach_contact_id, rep record
 * ids) are LLM-supplied parameters — the server resolves them from
 * message.call.id, and matches reps by name/email against MDR's list.
 */

const url = process.env.ORCHESTRATION_WEBHOOK_URL;
if (!url) {
  // Fail loudly instead of silently pushing a localhost URL to Vapi (Agent 2's
  // 2026-07-25 incident: a stale URL sent every tool-call to a dead tunnel).
  throw new Error("Missing required env var: ORCHESTRATION_WEBHOOK_URL");
}
export const ORCHESTRATION_WEBHOOK_URL = url;

/** Per-tool server config — includes the shared secret when VAPI_SERVER_SECRET is set. */
export function serverConfig() {
  return {
    url: ORCHESTRATION_WEBHOOK_URL,
    ...(process.env.VAPI_SERVER_SECRET ? { secret: process.env.VAPI_SERVER_SECRET } : {}),
  };
}

const DECLINE_REASONS = ["not_responsible", "refuses_to_assign", "already_assigned", "wrong_contact", "no_tai_id", "other"] as const;

const phoneDescription =
  "the phone number exactly as the broker said it, digits in the order spoken, including an extension " +
  "if they gave one (e.g. '813 555 1234 extension 204'). Never add a country code they didn't say.";

export const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "assign_existing_rep",
      description:
        "Assign one of the broker's EXISTING sales representatives (from the sales rep list) to this shipper. " +
        "Call as soon as the broker names someone who appears on the list. If the result says multiple_matches, " +
        "read each candidate's email and phone, ask which one, then call again with repEmail. If it says " +
        "missing_tai_id, ask for the TAI Sales Representative ID and call again with taiSalesRepId. If it says " +
        "no_match, treat the person as a new rep.",
      parameters: {
        type: "object",
        properties: {
          repName: { type: "string", description: "the rep's name as it appears on the sales rep list" },
          repEmail: { type: "string", description: "only to choose between reps with the same name" },
          taiSalesRepId: { type: "string", description: "only if the rep has no TAI ID on file and the broker just gave it" },
        },
        required: ["repName"],
      },
    },
    server: serverConfig(),
  },
  {
    type: "function" as const,
    function: {
      name: "create_new_rep",
      description:
        "Assign a NEW sales representative (not on the list). Call only once you have all four: name, email, " +
        "phone, and TAI Sales Representative ID, each confirmed back to the broker.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string", description: "exactly as spelled out by the broker" },
          phone: { type: "string", description: phoneDescription },
          taiSalesRepId: { type: "string", description: "the TAI Sales Representative ID, exactly as given" },
        },
        required: ["name", "email", "phone", "taiSalesRepId"],
      },
    },
    server: serverConfig(),
  },
  {
    type: "function" as const,
    function: {
      name: "schedule_callback",
      description:
        "Record a callback time the broker asked for (e.g. they need time to create the rep in TAI). If a new " +
        "rep's name/email/phone were already collected, include them so the callback only asks for the TAI ID.",
      parameters: {
        type: "object",
        properties: {
          callbackDateTime: {
            type: "string",
            description:
              "plain wall-clock date/time in the broker's local time, e.g. 2026-11-05T15:30:00. No UTC offset, no 'Z'. " +
              "For relative times ('in an hour'), add to {{currentTime}} on {{currentDate}}.",
          },
          reason: { type: "string", description: "short reason, e.g. 'creating rep in TAI'" },
          pendingRepName: { type: "string" },
          pendingRepEmail: { type: "string" },
          pendingRepPhone: { type: "string", description: phoneDescription },
        },
        required: ["callbackDateTime"],
      },
    },
    server: serverConfig(),
  },
  {
    type: "function" as const,
    function: {
      name: "log_decline",
      description: "Record that the broker won't assign a sales representative on this call and doesn't want a callback.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", enum: DECLINE_REASONS as unknown as string[] },
          note: { type: "string", description: "free-text detail; required if reason is 'other'" },
        },
        required: ["reason"],
      },
    },
    server: serverConfig(),
  },
  // Vapi's built-in call-termination tool — no server URL, handled natively.
  { type: "endCall" as const },
];
