/**
 * Emulation — an admin acting inside an organization they hold no membership in, entered
 * deliberately from Admin settings → Organizations and marked in the chrome the whole time.
 *
 * The ticket lives in its own cookie rather than in `ACTIVE_ORGANIZATION_COOKIE`, so an
 * organization an admin is a member of and one they're only visiting can never be the same
 * state. It carries its own expiry: the cookie's `maxAge` drops it from the browser, and
 * `parseEmulationTicket` refuses it server-side once the timestamp passes, so a clock-skewed
 * or hand-written cookie expires the same way.
 *
 * It isn't signed. Forging it grants nothing — `resolveDashboardSession` honors a ticket only
 * for a user whose `admin` flag is set in the database, and an admin can enter emulation
 * through the button anyway.
 */
import { cookies } from "next/headers";
import { adminActor, recordActivity } from "@/lib/activity/record";

export const EMULATION_COOKIE = "pouch_emulation";

/** How long emulation lasts before it ends on its own. */
export const EMULATION_DURATION_MS = 30 * 60_000;

export interface EmulationTicket {
  organizationId: string;
  expiresAt: Date;
}

/** `<organization id>:<expiry in ms>`. Returns null for anything malformed or past. */
export function parseEmulationTicket(raw: string | null | undefined, now: Date = new Date()): EmulationTicket | null {
  if (!raw) return null;
  const separator = raw.lastIndexOf(":");
  if (separator <= 0) return null;
  const organizationId = raw.slice(0, separator);
  const expires = Number(raw.slice(separator + 1));
  if (!organizationId || !Number.isFinite(expires) || expires <= now.getTime()) return null;
  return { organizationId, expiresAt: new Date(expires) };
}

export async function readEmulationTicket(now: Date = new Date()): Promise<EmulationTicket | null> {
  const cookieStore = await cookies();
  return parseEmulationTicket(cookieStore.get(EMULATION_COOKIE)?.value, now);
}

/** Writes the ticket. The caller checks the admin flag and the membership first. */
export async function startEmulation(organizationId: string, now: Date = new Date()): Promise<Date> {
  const expiresAt = new Date(now.getTime() + EMULATION_DURATION_MS);
  const cookieStore = await cookies();
  cookieStore.set(EMULATION_COOKIE, `${organizationId}:${expiresAt.getTime()}`, {
    path: "/",
    maxAge: Math.floor(EMULATION_DURATION_MS / 1000),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return expiresAt;
}

export async function endEmulation(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(EMULATION_COOKIE);
}

/**
 * Ends emulation and records it in the organization that was being emulated. Everything that
 * moves the session somewhere else goes through this, so leaving is never half-done.
 */
export async function leaveEmulation(admin: { id: string; label: string }): Promise<EmulationTicket | null> {
  const ticket = await readEmulationTicket();
  await endEmulation();
  if (!ticket) return null;
  await recordActivity({
    organizationId: ticket.organizationId,
    action: "session.emulation.ended",
    actor: adminActor(admin.id, admin.label),
  });
  return ticket;
}
