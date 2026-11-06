/**
 * A person's time zone, and the calendar arithmetic the dashboard does in it. Stored as an IANA
 * name, null for UTC. Everything that reaches the API stays UTC.
 */

export const UTC = "UTC";

let supported: Set<string> | null = null;

/** Every zone a person can pick: UTC, then the runtime's IANA list. */
export function timeZones(): string[] {
  return [UTC, ...Intl.supportedValuesOf("timeZone")];
}

export function isTimeZone(value: string): boolean {
  supported ??= new Set(timeZones());
  return supported.has(value);
}

/**
 * The listed name for any zone the runtime understands, or null. Aliases resolve the way the
 * runtime's own list spells them: `Asia/Kolkata` is `Asia/Calcutta` in Node, `Etc/UTC` is `UTC`.
 */
export function canonicalZone(value: string): string | null {
  if (isTimeZone(value)) return value;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
    return isTimeZone(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/** The stored value as a zone to format in. */
export function zoneOrUtc(stored: string | null | undefined): string {
  return stored && isTimeZone(stored) ? stored : UTC;
}

const partsFormats = new Map<string, Intl.DateTimeFormat>();

function partsFormat(zone: string): Intl.DateTimeFormat {
  let format = partsFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partsFormats.set(zone, format);
  }
  return format;
}

export interface ZonedParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

/** Wall-clock fields for `date` in `zone`, zero-padded. */
export function zonedParts(date: Date, zone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of partsFormat(zone).formatToParts(date)) parts[part.type] = part.value;
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** `2026-09-28`, the calendar day `date` falls on in `zone`. */
export function zonedDayKey(date: Date, zone: string): string {
  const { year, month, day } = zonedParts(date, zone);
  return `${year}-${month}-${day}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD` key. */
export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + count)).toISOString().slice(0, 10);
}

/** Milliseconds `zone`'s wall clock runs ahead of UTC at `date`. */
function offsetMs(date: Date, zone: string): number {
  const { year, month, day, hour, minute, second } = zonedParts(date, zone);
  const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant `day` starts in `zone`. */
export function startOfZonedDay(day: string, zone: string): Date {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  const guess = midnight - offsetMs(new Date(midnight), zone);
  // A DST change between UTC midnight and local midnight moves the offset once.
  return new Date(midnight - offsetMs(new Date(guess), zone));
}

/** `2026-09-28` as the Date the day-keyed charts carry: UTC midnight of that calendar day. */
export function calendarDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/** Zones the runtime's list still spells by a name IANA has since replaced. */
export const MODERN_NAMES: Record<string, string> = {
  "Africa/Asmera": "Africa/Asmara",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Coral_Harbour": "America/Atikokan",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Mendoza": "America/Argentina/Mendoza",
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Europe/Kiev": "Europe/Kyiv",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
};

/** `Asia/Kolkata` for the listed `Asia/Calcutta`; the name IANA uses today. */
export function modernName(zone: string): string {
  return MODERN_NAMES[zone] ?? zone;
}

/** `America/Los Angeles`: the current IANA name as a person reads it. */
export function zoneName(zone: string): string {
  return modernName(zone).replaceAll("_", " ");
}
