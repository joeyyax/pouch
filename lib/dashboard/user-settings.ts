import { and, desc, eq, sql } from "drizzle-orm";
import { getAuthenticatorName } from "@better-auth/passkey";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { accounts, passkeys, sessions, users } from "@/lib/db/schema";
import { canonicalZone, modernName, timeZones, UTC, zoneName } from "@/lib/time-zone";

export interface PasskeySummary {
  id: string;
  label: string;
  createdAt: Date;
}

export interface SessionSummary {
  id: string;
  token: string;
  device: string;
  ipAddress: string | null;
  createdAt: Date;
  expiresAt: Date;
  current: boolean;
}

/** Removing the only passkey with no password on the account would lock the user out entirely. */
export class LastCredentialError extends Error {
  constructor() {
    super("This is the only way into this account. Add a password or another passkey before removing it.");
    this.name = "LastCredentialError";
  }
}

/** A passkey or session id that doesn't belong to the acting user. Reported as not found, never as whose it is. */
export class NotOwnedError extends Error {
  constructor() {
    super("Not found.");
    this.name = "NotOwnedError";
  }
}

/** Revoking the session making the request would leave the screen open but signed out. */
export class CurrentSessionError extends Error {
  constructor() {
    super("This is your current session. Sign out instead of revoking it.");
    this.name = "CurrentSessionError";
  }
}

function labelPasskey(row: { name: string | null; deviceType: string; aaguid: string | null }): string {
  const named = row.name?.trim();
  if (named) return named;
  const known = row.aaguid ? getAuthenticatorName(row.aaguid) : undefined;
  if (known) return known;
  return row.deviceType === "multiDevice" ? "Synced passkey" : "Passkey";
}

export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  const rows = await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.userId, userId))
    .orderBy(passkeys.createdAt);

  return rows.map((row) => ({ id: row.id, label: labelPasskey(row), createdAt: row.createdAt }));
}

export async function hasPasswordCredential(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);
  return Boolean(row);
}

/**
 * Removes a passkey the caller owns. Refuses when it's the account's last passkey and there's
 * no password to fall back on — that combination is a lockout, not a preference.
 */
export async function removePasskey(userId: string, id: string, headers: Headers): Promise<void> {
  const owned = await db
    .select({ id: passkeys.id })
    .from(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
    .limit(1);
  if (owned.length === 0) throw new NotOwnedError();

  const remaining = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId));
  if (remaining.length <= 1 && !(await hasPasswordCredential(userId))) throw new LastCredentialError();

  await auth.api.deletePasskey({ headers, body: { id } });
}

export async function listSessions(userId: string, currentToken: string): Promise<SessionSummary[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt));

  const now = new Date();
  return rows
    .filter((row) => row.expiresAt > now)
    .map((row) => ({
      id: row.id,
      token: row.token,
      device: row.userAgent ?? "Unknown device",
      ipAddress: row.ipAddress,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      current: row.token === currentToken,
    }));
}

/**
 * Revokes a session the caller owns. Refuses the session making the request — that's a
 * sign-out, handled explicitly by the sign-out button, never a silent dead screen.
 */
export async function revokeSession(userId: string, token: string, currentToken: string, headers: Headers): Promise<void> {
  if (token === currentToken) throw new CurrentSessionError();

  const owned = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.token, token), eq(sessions.userId, userId)))
    .limit(1);
  if (owned.length === 0) throw new NotOwnedError();

  await auth.api.revokeSession({ headers, body: { token } });
}

/** Signs out every session but the one making the request. Returns how many ended. */
export async function revokeOtherSessions(userId: string, currentToken: string, headers: Headers): Promise<number> {
  const others = (await listSessions(userId, currentToken)).filter((session) => !session.current).length;
  if (others > 0) await auth.api.revokeOtherSessions({ headers });
  return others;
}

export async function updateName(userId: string, name: string, headers: Headers): Promise<void> {
  await auth.api.updateUser({ headers, body: { name } });
  // Guards against a stale session cookie: updateUser only writes through the adapter when
  // called with a live session, which is always true here since headers came from one.
  await db.update(users).set({ name }).where(eq(users.id, userId));
}

/** Sets the zone the dashboard shows dates in. Null is UTC. `zone` is already validated by `timeZoneInput`. */
export async function updateTimeZone(userId: string, zone: string | null): Promise<void> {
  await db.update(users).set({ timeZone: zone }).where(eq(users.id, userId));
}

export interface TimeZoneOption {
  value: string;
  /** `Asia/Kolkata (GMT+05:30)`, with the offset as it stands `now`. */
  label: string;
  /** Other names for the same zone, lowercased with spaces for underscores, for search: `asia/calcutta`, `us/pacific`. */
  aliases: string[];
}

let aliasCache: Promise<Map<string, string[]>> | null = null;

/** Every name Postgres knows, grouped under the listed zone it resolves to. Read once per process. */
function zoneAliases(): Promise<Map<string, string[]>> {
  aliasCache ??= db
    .execute<{ name: string }>(sql`select name from pg_timezone_names where name not like 'posix/%'`)
    .then((rows) => {
      const byZone = new Map<string, string[]>();
      for (const { name } of rows) {
        const zone = canonicalZone(name);
        if (!zone || zone === name) continue;
        byZone.set(zone, [...(byZone.get(zone) ?? []), name]);
      }
      return byZone;
    })
    .catch((error: unknown) => {
      aliasCache = null;
      throw error;
    });
  return aliasCache;
}

const searchable = (name: string) => name.toLowerCase().replaceAll("_", " ");

/** Every zone the settings field offers, UTC first. */
export async function timeZoneOptions(now: Date = new Date()): Promise<TimeZoneOption[]> {
  const aliases = await zoneAliases().catch(() => new Map<string, string[]>());
  return timeZones().map((zone) => {
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(now)
      .find((part) => part.type === "timeZoneName")?.value;
    const names = new Set([zone, modernName(zone), ...(aliases.get(zone) ?? [])].map(searchable));
    names.delete(searchable(modernName(zone)));
    return {
      value: zone,
      label: zone !== UTC && offset ? `${zoneName(zone)} (${offset})` : zoneName(zone),
      aliases: [...names],
    };
  });
}
