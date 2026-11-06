/**
 * Time as the voice doc words it: relative under a day, absolute after.
 * Absolute output is in the viewer's zone, which the server session hands the client.
 */

import { zonedParts } from "@/lib/time-zone";

const UNITS: [limit: number, seconds: number, name: string][] = [
  [60, 1, "second"],
  [3600, 60, "minute"],
  [86400, 3600, "hour"],
];

/** Relative under 24 hours, absolute after. */
export function timeLabel(date: Date, zone: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  for (const [limit, size, name] of UNITS) {
    if (seconds >= limit) continue;
    const count = Math.max(1, Math.floor(seconds / size));
    return `${count} ${name}${count === 1 ? "" : "s"} ago`;
  }
  return absoluteTime(date, zone);
}

/** Forward-looking twin of timeLabel, for a deadline: a backoff, a retry. */
export function untilLabel(date: Date, zone: string, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  if (seconds <= 0) return "now";
  for (const [limit, size, name] of UNITS) {
    if (seconds >= limit) continue;
    const count = Math.max(1, Math.floor(seconds / size));
    return `in ${count} ${name}${count === 1 ? "" : "s"}`;
  }
  return absoluteTime(date, zone);
}

/** `2026-09-07 14:32`. */
export function absoluteTime(date: Date, zone: string): string {
  const { year, month, day, hour, minute } = zonedParts(date, zone);
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/** `14:32:07` — timelines are always absolute, with seconds. */
export function clockTime(date: Date, zone: string): string {
  const { hour, minute, second } = zonedParts(date, zone);
  return `${hour}:${minute}:${second}`;
}

/** `2026-09-08`, for a date with no useful time of day. */
export function dayLabel(date: Date, zone: string): string {
  const { year, month, day } = zonedParts(date, zone);
  return `${year}-${month}-${day}`;
}

const zoneNames = new Map<string, Intl.DateTimeFormat>();

/** `PDT`, `UTC` or `GMT+2`: the zone's short name at `date`. */
export function zoneLabel(date: Date, zone: string): string {
  let format = zoneNames.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" });
    zoneNames.set(zone, format);
  }
  return format.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? zone;
}

/** `2026-09-07 14:32 PDT`, for a hover. */
export function zonedTime(date: Date, zone: string): string {
  return `${absoluteTime(date, zone)} ${zoneLabel(date, zone)}`;
}

/** "12 minutes", for the queued-past-window line. */
export function durationLabel(date: Date, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

/** `12 KB body · 84 KB attachments`. Null when the message predates recorded sizes. */
export function messageSizeLabel(size: { body_bytes: number | null; attachment_bytes: number | null }): string | null {
  const parts: string[] = [];
  if (size.body_bytes !== null) parts.push(`${byteLabel(size.body_bytes)} body`);
  if (size.attachment_bytes) parts.push(`${byteLabel(size.attachment_bytes)} attachments`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** `84 KB`. Attachment sizes, decoded. */
export function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
