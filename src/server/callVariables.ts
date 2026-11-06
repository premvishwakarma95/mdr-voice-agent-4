/**
 * Builds the Vapi variableValues for an Agent 4 call from MDR's
 * shipment-opportunity webhook payload.
 *
 * MDR rule (2026-11-05): pass everything to the agent; speak every value MDR
 * provides, but if a value is null/empty, don't mention that field at all
 * (no "destination: not available"). So `shipmentDetails` is pre-rendered
 * here with only the present fields, and the prompt reads it as-is.
 *
 * Every field is read with optional chaining — a missing object or field
 * never throws, it's just left out.
 */
import { greetingForTimezone, formatCurrentTime, isValidTimezone } from "./callingWindow.js";

export interface MdrSalesRep {
  id?: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  account_id?: number;
  sales_rep_id?: string | null;
}

export interface ShipmentOpportunityPayload {
  shipper?: {
    id?: number;
    name?: string | null;
    city?: string | null;
    state?: string | null;
    zip_code?: string | null;
    address?: string | null;
    phone?: string | null;
  } | null;
  shipment?: {
    id?: number;
    quote_id?: number | string | null;
    weight?: number | string | null;
    length?: number | string | null;
    origin_zip?: string | null;
    destination_zip?: string | null;
    freight_class?: string | null;
    equipment_type?: string | null;
    commodity_description?: string | null;
    customer_reference_number?: string | null;
  } | null;
  broker_sales_reps?: MdrSalesRep[] | null;
  company_name?: string | null;
  contact_name?: string | null;
  email?: string | null;
  phone?: string | null;
  timezone?: string | null;
}

/** null, undefined, and blank/whitespace-only strings all count as "not provided". */
function present(value: unknown): value is string | number {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  return typeof value === "number" && Number.isFinite(value);
}

/** "63130" -> "6 3 1 3 0" so TTS reads a ZIP digit by digit, not as sixty-three thousand. */
function spellDigits(value: string | number): string {
  return String(value).trim().split("").join(" ");
}

/**
 * Spoken shipment lines, in the transcript's order (Pickup, Destination,
 * Equipment, Length, Commodity) — only these script fields, and only when
 * MDR sent a value. Weight/freight class are deliberately not spoken (MDR
 * gives no unit for weight); they stay in rawShipment if the broker asks.
 * Only fields with a real value are included.
 */
export function buildShipmentDetails(payload: ShipmentOpportunityPayload): string {
  const s = payload?.shipment;
  const lines: string[] = [];

  if (present(s?.origin_zip)) lines.push(`Pickup: ZIP ${spellDigits(s.origin_zip)}`);
  if (present(s?.destination_zip)) lines.push(`Destination: ZIP ${spellDigits(s.destination_zip)}`);
  if (present(s?.equipment_type)) lines.push(`Equipment: ${s.equipment_type}`);
  if (present(s?.length)) lines.push(`Length: ${s.length}`);
  if (present(s?.commodity_description)) lines.push(`Commodity: ${s.commodity_description}`);

  return lines.join("\n");
}

/** Known reps as plain text for the prompt — name only is always shown; email/phone only if present. */
export function buildSalesRepList(payload: ShipmentOpportunityPayload): string {
  const reps = payload?.broker_sales_reps ?? [];
  return reps
    .filter((rep) => present(rep?.name))
    .map((rep) => {
      const parts = [`${rep.name}`];
      if (present(rep?.email)) parts.push(`email ${rep.email}`);
      if (present(rep?.phone)) parts.push(`phone ${rep.phone}`);
      parts.push(present(rep?.sales_rep_id) ? `TAI ID on file` : `no TAI ID on file`);
      return `- ${parts.join(", ")}`;
    })
    .join("\n");
}

/** IANA zone for the calling window/greeting: payload's own if valid, else CALLING_TIMEZONE, else US Eastern. */
export function resolveTimezone(contact: { timezone?: string | null } | null | undefined): string {
  if (isValidTimezone(contact?.timezone)) return contact.timezone;
  if (isValidTimezone(process.env.CALLING_TIMEZONE)) return process.env.CALLING_TIMEZONE;
  return "America/New_York";
}

function formatCurrentDate(timezone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(at);
}

/** "You have received a new shipment inquiry from X regarding Quote number N." — parts omitted when null. */
export function buildInquirySentence(payload: ShipmentOpportunityPayload): string {
  const shipper = present(payload?.shipper?.name) ? ` from ${payload.shipper.name}` : "";
  const quote = present(payload?.shipment?.quote_id) ? ` regarding Quote number ${payload.shipment.quote_id}` : "";
  return `You have received a new shipment inquiry${shipper}${quote}.`;
}

const squash = (v: unknown) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The person to ask for, or "" when MDR gave no real person — contact_name
 * missing, or just the company name repeated (seen in MDR test data:
 * contact_name "Adience Developer Test 1" = company_name). Asking
 * "Hi, is this IBR Infotech?" sounds broken, so those fall back to asking for
 * whoever handles sales-rep assignments.
 */
export function contactPersonName(payload: ShipmentOpportunityPayload): string {
  if (!present(payload?.contact_name)) return "";
  const name = String(payload.contact_name).trim();
  if (present(payload?.company_name) && squash(name) === squash(payload.company_name)) return "";
  return name;
}

/** Opening line, spoken as the per-call firstMessage override (same pattern as Agent 2). */
export function buildFirstMessage(payload: ShipmentOpportunityPayload, timezone: string): string {
  const greeting = greetingForTimezone(timezone);
  const person = contactPersonName(payload);
  if (person) return `[warm] ${greeting}! Hi, is this ${person}?`;
  if (present(payload?.company_name)) {
    return `[warm] ${greeting}! Hi, this is Everly calling on behalf of MDR. Am I speaking with someone at ${String(payload.company_name).trim()} who handles sales representative assignments?`;
  }
  return `[warm] ${greeting}! Hi, this is Everly calling on behalf of MDR. Who am I speaking with?`;
}

/** Voicemail, built server-side so a missing field never leaves a gap in the sentence. */
export function buildVoicemailMessage(payload: ShipmentOpportunityPayload): string {
  const person = contactPersonName(payload);
  const name = person ? `Hi ${person}, ` : "Hi, ";
  return (
    `${name}this is Everly, calling on behalf of MDR, My Dray Rate. ${buildInquirySentence(payload)} ` +
    "We need a sales representative assigned to this shipper. I'll follow up again later. Thank you."
  );
}

export interface CallContext {
  attemptNumber: number;
  isFinalAttempt: boolean;
  /** Set when this call is a broker-requested callback. */
  callback?: {
    reason?: string | null;
    pendingRep?: { name?: string | null; email?: string | null; phone?: string | null; isExistingRep?: boolean | null } | null;
  } | null;
}

/** Plain-language note for the prompt about why we're calling back, or "" on a normal call. */
function buildCallbackContext(ctx: CallContext): string {
  if (!ctx?.callback) return "";
  const rep = ctx.callback.pendingRep;
  if (present(rep?.name)) {
    const details = [present(rep?.email) ? `email ${rep.email}` : "", present(rep?.phone) ? `phone ${rep.phone}` : ""]
      .filter(Boolean)
      .join(", ");
    if (rep?.isExistingRep) {
      return (
        `This is a callback the broker asked for. On the last call they chose an EXISTING sales representative ` +
        `already on their list, ${rep.name}${details ? ` (${details})` : ""}, but that rep had no TAI Sales ` +
        `Representative ID yet. Only ask for the TAI Sales Representative ID now, then call assign_existing_rep ` +
        `with repName "${rep.name}"${present(rep?.email) ? `, repEmail "${rep.email}"` : ""} and the taiSalesRepId.`
      );
    }
    return (
      `This is a callback the broker asked for. On the last call they named a NEW sales representative, ` +
      `${rep.name}${details ? ` (${details})` : ""}, but didn't have the TAI Sales Representative ID yet. ` +
      `You already have those details — only ask for the TAI Sales Representative ID now, then call ` +
      `create_new_rep with those details and the taiSalesRepId.`
    );
  }
  return `This is a callback the broker asked for${present(ctx.callback.reason) ? ` (reason: ${ctx.callback.reason})` : ""}.`;
}

export function buildCallVariables(
  payload: ShipmentOpportunityPayload,
  timezone: string,
  ctx: CallContext
): Record<string, string> {
  const s = payload?.shipment;
  const now = new Date();
  return {
    // The person being called (broker employee) — {Broker Name} in the script.
    // "" → no real person on file; the prompt then asks for whoever handles
    // sales-rep assignments (see contactPersonName).
    brokerName: contactPersonName(payload) || "the person who handles sales representative assignments",
    brokerCompany: present(payload?.company_name) ? String(payload.company_name) : "",
    shipperName: present(payload?.shipper?.name) ? String(payload.shipper.name) : "",
    quoteId: present(s?.quote_id) ? String(s.quote_id) : "",
    inquirySentence: buildInquirySentence(payload),
    // Pre-filtered: only fields MDR actually provided. Read verbatim.
    shipmentDetails: buildShipmentDetails(payload),
    salesRepList: buildSalesRepList(payload) || "(none on file)",
    // Everything MDR sent, untouched, for the agent's reference (e.g. a
    // broker asking about the reference number). Not read out unprompted.
    rawShipment: JSON.stringify(s ?? {}),
    rawShipper: JSON.stringify(payload?.shipper ?? {}),
    // Time anchors in the broker's zone — needed for relative callbacks ("in an hour").
    greeting: greetingForTimezone(timezone, now),
    currentDate: formatCurrentDate(timezone, now),
    currentTime: formatCurrentTime(timezone, now),
    timezone,
    attemptStatus: ctx?.isFinalAttempt
      ? "This is the FINAL scheduled call attempt for this contact."
      : `This is call attempt ${ctx?.attemptNumber ?? 1}.`,
    callbackContext: buildCallbackContext(ctx),
  };
}
