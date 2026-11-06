/** An inactive row: text drops to the muted ink, which holds AA in both themes, and marks fade. */
export const INACTIVE_ROW = "[&_*]:text-muted-foreground! [&_svg]:opacity-40";

/** Nothing added in this window reads as inactive: it may still be getting set up. */
export const SETTLING_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export function settled(createdAt: Date | string, now = Date.now()): boolean {
  return now - new Date(createdAt).getTime() > SETTLING_DAYS * DAY_MS;
}
