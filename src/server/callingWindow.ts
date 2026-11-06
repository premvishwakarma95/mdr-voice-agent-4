/**
 * Timezone-aware calling window: business days/hours in the carrier's local
 * time. Both come from env (CALLING_WINDOW_DAYS, CALLING_WINDOW_START_HOUR,
 * CALLING_WINDOW_END_HOUR), not hardcoded — defaults match the confirmed
 * client rule (Mon-Fri, 8am-5pm) if unset.
 *
 * Timezone always comes from a FRESH MDR API response's carrier_timezone,
 * never the locally stored Carrier.calling_window.startingTime/endTime,
 * which is deliberately ignored per instruction.
 */
/**
 * `Number(process.env.X ?? fallback)` has a real gap: `??` only catches
 * null/undefined, not an empty string — a misconfigured `.env` with a
 * trailing `=` and no value (CALLING_WINDOW_START_HOUR=) would silently
 * parse to 0 (midnight) instead of falling back to the intended default. A
 * garbage non-numeric value would silently parse to NaN, which makes every
 * calling-window comparison false — no crash, just calls that silently
 * never go out. Both cases fall back to the given default here instead.
 */
function envHour(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
}

export const CALLING_WINDOW_START_HOUR = envHour("CALLING_WINDOW_START_HOUR", 8);
export const CALLING_WINDOW_END_HOUR = envHour("CALLING_WINDOW_END_HOUR", 17);
// Normalized to match Intl.DateTimeFormat's weekday: "short" casing ("Mon",
// "Tue", ...) regardless of how CALLING_WINDOW_DAYS happens to be cased.
function normalizeDay(day: string): string {
  const trimmed = day.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1, 3).toLowerCase();
}
export const BUSINESS_DAYS = new Set(
  (process.env.CALLING_WINDOW_DAYS ?? "Mon,Tue,Wed,Thu,Fri").split(",").filter(Boolean).map(normalizeDay)
);

/** Zone's offset from UTC in minutes at a given instant, e.g. America/Chicago in August -> -300. */
function offsetMinutesForZone(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(at);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const match = tzName.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!match) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = match[3] ? Number(match[3]) : 0;
  return sign * (hours * 60 + minutes);
}

/**
 * Interprets a date-time string as wall-clock local time IN `timeZone`,
 * ignoring any trailing Z/offset the string might carry — a real test call
 * showed the LLM sending schedule_callback's callbackDateTime with no offset
 * at all ("2026-08-10T21:00:00"), which native `new Date(...)` parsing then
 * silently read as the *server process's own* local timezone (IST on this
 * dev machine), not the carrier's — turning a carrier's stated "9 PM their
 * time" into the wrong absolute instant entirely, and defeating the calling-
 * window check built on top of it. Only the numeric date/time digits from
 * the LLM are trusted here; the authoritative zone is always the caller-
 * supplied one (attempt.timezone, MDR's real value), never anything the
 * string itself claims.
 */
export function wallClockToUtc(dateTimeString: string, timeZone: string): Date {
  const match = dateTimeString.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) {
    throw new Error(`Unparseable date/time: ${JSON.stringify(dateTimeString)}`);
  }
  const [, year, month, day, hour, minute, second] = match;
  const naiveUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    second ? Number(second) : 0
  );
  const offsetMinutes = offsetMinutesForZone(timeZone, new Date(naiveUtc));
  return new Date(naiveUtc - offsetMinutes * 60_000);
}

/** 12-hour "8 AM"-style formatting, e.g. hour 17 -> "5 PM", hour 0 -> "12 AM". */
function formatHour12(hour: number): string {
  const period = hour >= 12 ? "PM" : "AM";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour} ${period}`;
}

/**
 * Human-readable calling window, e.g. "Monday through Friday, 8 AM to 5 PM
 * your time" — used both to tell a carrier our hours up front and to explain
 * why a proposed callback time was rejected (see schedule_callback in
 * webhookHandlers.ts).
 */
const WEEKDAY_NAMES: Record<string, string> = {
  Mon: "Monday",
  Tue: "Tuesday",
  Wed: "Wednesday",
  Thu: "Thursday",
  Fri: "Friday",
  Sat: "Saturday",
  Sun: "Sunday",
};
export function formatCallingWindow(): string {
  const days = [...BUSINESS_DAYS];
  const dayRange =
    days.length > 0 ? `${WEEKDAY_NAMES[days[0]] ?? days[0]} through ${WEEKDAY_NAMES[days[days.length - 1]] ?? days[days.length - 1]}` : "our business days";
  return `${dayRange}, ${formatHour12(CALLING_WINDOW_START_HOUR)} to ${formatHour12(CALLING_WINDOW_END_HOUR)} your time`;
}

/**
 * Checks a timezone string is a real IANA identifier before it's used
 * anywhere else — Intl.DateTimeFormat throws a RangeError on an invalid one,
 * and MDR's staging data has already shown enough inconsistency (missing
 * fields, mismatched types) that a blank/malformed carrier_timezone is a
 * real possibility, not a hypothetical.
 */
export function isValidTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== "string" || !timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function localParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  // Node 20's ICU (confirmed on production, v20.20.2/ICU 78.2 — not
  // reproducible on a newer Node) formats local midnight as hour "24"
  // instead of "00" with hour12: false. Invisible under the real calling
  // window (END_HOUR=17, where 24 is already out of range either way), but
  // with END_HOUR=24 (used for on-demand testing) it wrongly excludes every
  // carrier for the midnight-to-~1am local hour, every day: 24 < 24 is
  // false. Normalize back to 0 so both mean the same real instant.
  const rawHour = parseInt(get("hour"), 10);

  return {
    weekday: get("weekday"),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: parseInt(get("minute"), 10),
  };
}

/**
 * "Good morning"/"Good afternoon"/"Good evening" based on the carrier's real
 * local hour (same isValidTimezone-gated carrier_timezone every other
 * timezone-aware call already uses — never the server's own local time, see
 * wallClockToUtc's header comment for why that distinction matters here too).
 * Ordinary conversational morning/afternoon/evening boundaries (noon, 5pm) —
 * deliberately NOT tied to CALLING_WINDOW_START_HOUR/END_HOUR, which govern
 * when we're allowed to call at all, a separate concern from what a human
 * would naturally say at a given hour.
 */
export function greetingForTimezone(timezone: string, at: Date = new Date()): string {
  const { hour } = localParts(at, timezone);
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/**
 * "10:49 AM"-style current clock time in the carrier's real local timezone —
 * same gap class as currentDate in callVariables.ts (added after a real call
 * showed the model resolving relative dates against the wrong year with no
 * anchor), one level more granular: nothing previously told the model what
 * time it actually is right now, so a carrier's relative callback request
 * ("call me in 13 minutes") had no real anchor to compute against. Confirmed
 * root cause of a real test call (2026-08-31): asked to schedule a callback
 * "in 13 minutes," the model instead anchored to its own earlier
 * conversational guess of a clock time and added the offset to THAT instead
 * of the actual current time, landing the callback ~7h45m off target.
 */
export function formatCurrentTime(timezone: string, at: Date = new Date()): string {
  const { hour, minute } = localParts(at, timezone);
  const period = hour >= 12 ? "PM" : "AM";
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelveHour}:${String(minute).padStart(2, "0")} ${period}`;
}

export function isWithinCallingWindow(timezone: string, at: Date = new Date()): boolean {
  const { weekday, hour } = localParts(at, timezone);
  if (!BUSINESS_DAYS.has(weekday)) return false;
  return hour >= CALLING_WINDOW_START_HOUR && hour < CALLING_WINDOW_END_HOUR;
}

/** `at`'s year/month/day as seen in `timezone` — the calendar-day half of localParts. */
function localDateParts(at: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = formatter.formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
}

/**
 * The UTC instant corresponding to `hour:minute` wall-clock time, on the
 * same local calendar day `at` falls on in `timezone`. Same construction
 * technique as wallClockToUtc (naive UTC components, then corrected by the
 * zone's real offset at that instant) — used to land exactly on a clean
 * HH:00 boundary instead of drifting by whatever minute the search started
 * from.
 */
function localTimeOnSameDayAsUtc(at: Date, timezone: string, hour: number, minute: number): Date {
  const { year, month, day } = localDateParts(at, timezone);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsetMinutes = offsetMinutesForZone(timezone, new Date(naiveUtc));
  return new Date(naiveUtc - offsetMinutes * 60_000);
}

/**
 * Returns the next moment (UTC Date) at which the calling window opens for
 * this timezone, starting from `from`. If already within the window,
 * returns `from` unchanged (the remaining wait, if any, still applies).
 * Otherwise snaps straight to the next eligible day's exact window-open
 * instant (CALLING_WINDOW_START_HOUR:00 local) — today if `from` is simply
 * before today's window opens, the next business day otherwise. Once the
 * window is closed, whatever cadence wait already elapsed is considered
 * fully served; the call is due right when the window opens, not at
 * window-open-time-plus-whatever-minute `from` happened to carry (the
 * earlier 30-minutes-at-a-time walk from `from` used to inherit that
 * leftover minute — confirmed wrong via live testing 2026-09-24: a 4:40 PM
 * Monday attempt landed at 8:10/8:17 AM Tuesday instead of a clean 8:00).
 * Walking day-by-day (not the old 30-min-step search) is what makes this
 * snap-to-HH:00 behavior possible — each candidate day is checked only for
 * "is this a business day with any window left today", and the actual
 * return value is always freshly constructed at hour:00, never carried
 * forward from a stepped timestamp.
 */
export function nextCallingWindowOpen(timezone: string, from: Date = new Date()): Date {
  if (isWithinCallingWindow(timezone, from)) return from;

  let candidate = new Date(from);
  for (let i = 0; i < 8; i++) {
    const { weekday, hour } = localParts(candidate, timezone);
    // The "has today's window already closed" check only makes sense for
    // `from`'s own day (i === 0) — advancing by a fixed 24h lands on the
    // same local hour every subsequent day, so re-checking `hour` for i > 0
    // would compare that SAME already-past hour forever and never find a
    // day (confirmed by hitting the throw below in testing). Every day
    // after the first is obviously still fully open, since the return value
    // is always a freshly built START_HOUR:00 on it, never the candidate's
    // own carried-over hour.
    const todayWindowAlreadyClosed = i === 0 && hour >= CALLING_WINDOW_END_HOUR;
    if (BUSINESS_DAYS.has(weekday) && !todayWindowAlreadyClosed) {
      return localTimeOnSameDayAsUtc(candidate, timezone, CALLING_WINDOW_START_HOUR, 0);
    }
    candidate = new Date(candidate.getTime() + 24 * 60 * 60_000);
  }
  throw new Error(`Could not find a calling window opening for timezone ${timezone}`);
}

/**
 * Next business-day morning (start of the window) — strictly a later
 * calendar day than `from`, used for cadence attempt #4, which is meant to
 * give a carrier a full day's rest after 3 same-day attempts regardless of
 * how wide the calling window is configured (with a 24-hour window,
 * `nextCallingWindowOpen(timezone, from)` alone would just return `from`
 * itself, since "always open" trivially includes right now — this function
 * exists specifically to skip that and force the next day).
 */
export function nextBusinessMorning(timezone: string, from: Date = new Date()): Date {
  let candidate = new Date(from.getTime() + 24 * 60 * 60_000);
  for (let i = 0; i < 8; i++) {
    const { weekday } = localParts(candidate, timezone);
    if (BUSINESS_DAYS.has(weekday)) {
      return localTimeOnSameDayAsUtc(candidate, timezone, CALLING_WINDOW_START_HOUR, 0);
    }
    candidate = new Date(candidate.getTime() + 24 * 60 * 60_000);
  }
  throw new Error(`Could not find next business morning for timezone ${timezone}`);
}
