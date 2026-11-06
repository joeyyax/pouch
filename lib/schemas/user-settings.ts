import { z } from "zod";
import { canonicalZone, UTC } from "@/lib/time-zone";

/** The time zone field: a listed zone or an alias of one, with UTC stored as null. */
export const timeZoneInput = z
  .string()
  .trim()
  .min(1, 'Field "timeZone" is required.')
  .transform((value, context) => {
    const zone = canonicalZone(value);
    if (zone) return zone === UTC ? null : zone;
    context.addIssue({ code: "custom", message: `Time zone "${value}" isn't recognized. Pick one from the list.` });
    return z.NEVER;
  });
