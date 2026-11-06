import { eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, memberships, messages, organizations, providers, users } from "@/lib/db/schema";
import type { OrganizationKeyRow } from "@/lib/api/keys";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { encryptCredentials, type ProviderRow } from "@/lib/providers";
import { newId } from "@/lib/ids";
import { ROLES, type OrgRole } from "@/lib/auth/permissions";
import { suppress } from "@/lib/messages/suppression";
import { DEFAULT_SYSTEM_FROM_ADDRESS, systemDomainFor } from "@/lib/mail/system";
import { setSystemFromAddress } from "@/lib/settings/service";
import type { MessageRow } from "@/lib/db/schema";
import type { DashboardSession } from "@/lib/dashboard/session";

type MessageInsert = typeof messages.$inferInsert;

export interface Fixture {
  organizationId: string;
  providerId: string;
  domainId: string;
  key: OrganizationKeyRow;
  secret: string;
}

/**
 * An address on no domain. Tests start with system mail unconfigured so a fixture minting a key
 * doesn't mail itself through whichever domain happened to verify first — a test that wants
 * system mail calls `seedSystemOrganization` or clears the setting itself.
 */
export const NO_SYSTEM_FROM_ADDRESS = "support@none.example";

/** The slug `seedSystemOrganization` gives the organization holding the system from address's domain. */
const SYSTEM_MAIL_ORGANIZATION_SLUG = "system-mail";

const RESET_ROOTS = [
  "service_settings", "job_heartbeats", "message_stats_rollup", "activity", "exports", "webhook_attempts", "webhook_deliveries",
  "webhook_endpoints", "inbound_messages", "message_events", "messages", "bulk_fanout_recipients", "suppressions",
  "recipient_history", "api_keys", "domains", "providers", "organizations",
];

/** The roots plus every table that references one, the set `truncate ... cascade` would empty. */
let resetTables: string[] | null = null;
/** False once the database refused to switch off constraint checks, so reset falls back to truncate. */
let fastReset = true;

async function tablesToReset(): Promise<string[]> {
  if (resetTables) return resetTables;
  const rows = await db.execute<{ name: string }>(sql`
    with recursive reached(name) as (
      select unnest(${sql.raw(`array[${RESET_ROOTS.map((t) => `'${t}'`).join(",")}]`)}::text[])
      union
      select child.relname::text collate "default"
      from pg_constraint c
      join pg_class child on child.oid = c.conrelid
      join pg_class parent on parent.oid = c.confrelid
      join reached on reached.name = parent.relname
      where c.contype = 'f'
    )
    select name from reached
  `);
  resetTables = rows.map((row) => row.name);
  return resetTables;
}

export async function resetDatabase(): Promise<void> {
  if (fastReset) {
    try {
      const tables = await tablesToReset();
      // Deletes with constraint checks off: one truncate per test cost about 67ms, this about 2ms.
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        for (const table of tables) await tx.execute(sql.raw(`delete from "${table}"`));
      });
    } catch {
      fastReset = false;
    }
  }
  if (!fastReset) {
    await db.execute(sql.raw(`truncate table ${RESET_ROOTS.join(", ")} restart identity cascade`));
  }
  await setSystemFromAddress(NO_SYSTEM_FROM_ADDRESS);
}

export interface FixtureOptions {
  domainStatus?: "pending" | "verified";
  keyMode?: "live" | "test";
  /** Empty means the key is scoped to every domain in the organization. */
  scopeToDomain?: boolean;
  concurrency?: number;
  providerAdapter?: string;
  /** Non-secret provider config, such as a webhook public key. */
  settings?: Record<string, string>;
  credentials?: Record<string, string>;
  /** Admin opt-in for bulk sending (#246). Defaults to the schema default, false. */
  bulkAllowed?: boolean;
}

export async function seedFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const organizationId = newId("organization");
  await db.insert(organizations).values({ id: organizationId, name: "Test", slug: `test-${organizationId}` });

  const providerId = newId("provider");
  await db.insert(providers).values({
    id: providerId,
    organizationId,
    adapter: options.providerAdapter ?? "mock",
    name: "primary",
    credentials: encryptCredentials(options.credentials ?? { serverToken: "test-token" }),
    settings: options.settings ?? {},
    concurrency: options.concurrency ?? 4,
  });

  const domainId = newId("domain");
  await db.insert(domains).values({
    id: domainId,
    organizationId,
    providerId,
    name: "example.com",
    status: options.domainStatus ?? "verified",
    verifiedAt: options.domainStatus === "pending" ? null : new Date(),
    ...(options.bulkAllowed !== undefined ? { bulkAllowed: options.bulkAllowed } : {}),
  });

  const minted = await createApiKey({
    organizationId,
    name: "test",
    mode: options.keyMode ?? "live",
    domainIds: options.scopeToDomain === false ? [] : [domainId],
  });

  return { organizationId, providerId, domainId, key: minted.key as OrganizationKeyRow, secret: minted.secret };
}

/** The provider a provider callback would have authenticated as, for `applyEvent`. */
export function eventSource(fixture: Fixture): { id: string; organizationId: string } {
  return { id: fixture.providerId, organizationId: fixture.organizationId };
}

export async function addSuppression(organizationId: string, address: string): Promise<void> {
  await suppress({ organizationId, address, reason: "hard_bounce", detail: "Mailbox does not exist" });
}
/** Adds a verified domain to an existing organization and mints a key scoped only to it. */
export async function addDomainKey(fixture: Fixture, name = "second.example.com"): Promise<{ domainId: string; key: OrganizationKeyRow; secret: string }> {
  return addDomainKeyFor(fixture, fixture.providerId, name);
}

/** Adds a second provider to the fixture's organization. */
export async function addProvider(
  fixture: Fixture,
  options: { providerAdapter: string; name?: string; credentials?: Record<string, string>; settings?: Record<string, string> } = { providerAdapter: "mock" },
): Promise<{ providerId: string }> {
  const providerId = newId("provider");
  await db.insert(providers).values({
    id: providerId,
    organizationId: fixture.organizationId,
    adapter: options.providerAdapter,
    name: options.name ?? "secondary",
    credentials: encryptCredentials(options.credentials ?? { serverToken: "test-token" }),
    settings: options.settings ?? {},
    concurrency: 4,
  });
  return { providerId };
}

/** Adds a verified domain bound to a specific provider. */
export async function addDomainKeyFor(
  fixture: Fixture,
  providerId: string,
  name: string,
): Promise<{ domainId: string; key: OrganizationKeyRow; secret: string }> {
  const domainId = newId("domain");
  await db.insert(domains).values({
    id: domainId,
    organizationId: fixture.organizationId,
    providerId,
    name,
    status: "verified",
    verifiedAt: new Date(),
  });

  const minted = await createApiKey({
    organizationId: fixture.organizationId,
    name: `scoped-${name}`,
    mode: fixture.key.mode,
    domainIds: [domainId],
  });

  return { domainId, key: minted.key as OrganizationKeyRow, secret: minted.secret };
}

export async function countMessages(): Promise<number> {
  const rows = await db.select({ id: messages.id }).from(messages);
  return rows.length;
}

/**
 * Gives system mail somewhere of its own to send from: an organization holding the system from
 * address's domain. The address can name any organization's domain — this fixture picks the
 * isolated shape so a test can tell system mail apart from a tenant's own log.
 */
export async function seedSystemOrganization(): Promise<{ organizationId: string; domainId: string }> {
  const organizationId = newId("organization");
  await db.insert(organizations).values({ id: organizationId, name: "Pouch", slug: SYSTEM_MAIL_ORGANIZATION_SLUG });

  const providerId = newId("provider");
  await db.insert(providers).values({
    id: providerId,
    organizationId,
    adapter: "mock",
    name: "system",
    credentials: encryptCredentials({}),
    settings: {},
    concurrency: 2,
  });

  const domainId = newId("domain");
  await db.insert(domains).values({
    id: domainId,
    organizationId,
    providerId,
    name: systemDomainFor(DEFAULT_SYSTEM_FROM_ADDRESS),
    status: "verified",
    verifiedAt: new Date(),
  });

  await setSystemFromAddress(DEFAULT_SYSTEM_FROM_ADDRESS);

  return { organizationId, domainId };
}

/** Leaves system mail with nowhere to send from, for asserting a failed alert can't take the work down with it. */
export async function disableSystemMail(): Promise<void> {
  await setSystemFromAddress(NO_SYSTEM_FROM_ADDRESS);
}

/** Every message system mail has sent so far: the service's own, under no organization. */
export async function systemMailMessages(): Promise<MessageRow[]> {
  return db.select().from(messages).where(isNull(messages.organizationId));
}

export type SeedMessageOptions = Partial<MessageInsert> & {
  /** Envelope shorthands — `recipients` and `envelope` are derived from these unless passed outright. */
  from?: string;
  fromName?: string | null;
  to?: string | string[];
  cc?: string[];
  bcc?: string[];
  attachmentCount?: number;
};

/**
 * Inserts a `messages` row, defaulting the organization and domain to the fixture's. Anything
 * on the row can be overridden by column name; `from`/`to`/`cc`/`bcc` fill in the envelope.
 */
export async function seedMessage(
  fixture: Pick<Fixture, "organizationId" | "domainId">,
  options: SeedMessageOptions = {},
): Promise<string> {
  const { from, fromName, to, cc, bcc, attachmentCount, ...row } = options;
  const id = row.id ?? newId("message");
  const createdAt = row.createdAt ?? new Date();
  const fromAddress = from ?? row.fromAddress ?? "hi@example.com";
  const toList = to === undefined ? ["name@example.com"] : Array.isArray(to) ? to : [to];
  const ccList = cc ?? [];
  const bccList = bcc ?? [];

  await db.insert(messages).values({
    organizationId: fixture.organizationId,
    domainId: fixture.domainId,
    status: "delivered",
    subject: "Your invite",
    tags: [],
    createdAt,
    updatedAt: createdAt,
    ...row,
    id,
    fromAddress,
    recipients: row.recipients ?? [...toList, ...ccList, ...bccList],
    envelope: row.envelope ?? {
      from: fromAddress,
      fromName: fromName ?? null,
      to: toList,
      cc: ccList,
      bcc: bccList,
      replyTo: [],
      headers: {},
      attachmentCount: attachmentCount ?? 0,
    },
  });
  return id;
}

/**
 * Inserts a `users` row, creating an organization for it when none is given. A `role` adds the
 * membership that `requireOrganization` reads; `admin` is service-wide and needs no membership.
 */
export async function seedUser(
  options: { organizationId?: string; admin?: boolean; name?: string; role?: OrgRole } = {},
): Promise<{ userId: string; email: string; organizationId: string }> {
  let organizationId = options.organizationId;
  if (!organizationId) {
    organizationId = newId("organization");
    await db.insert(organizations).values({ id: organizationId, name: "Test", slug: `test-${organizationId}` });
  }

  const userId = crypto.randomUUID();
  const email = `${userId}@example.com`;
  await db.insert(users).values({
    id: userId,
    organizationId,
    name: options.name ?? "Test User",
    email,
    admin: options.admin ?? false,
  });

  if (options.role) {
    await db.insert(memberships).values({ id: newId("membership"), userId, organizationId, role: options.role });
  }

  return { userId, email, organizationId };
}

/** A user with a membership in `organizationId`. */
export async function memberOf(organizationId: string, role: OrgRole = ROLES.MEMBER, admin = false): Promise<string> {
  return (await seedUser({ organizationId, role, admin })).userId;
}

// ---------------------------------------------------------------------------
// Session mocks and request helpers
//
// `vi.mock` factories are hoisted above every declaration in the test file, so they can't
// close over one. These take the state object `vi.hoisted` returns and are reached through
// `await import("./fixtures")` inside the factory, which runs late enough to be safe.
// ---------------------------------------------------------------------------

/** What a test flips to say who's signed in. Created with `vi.hoisted`. */
export interface AdminSessionState {
  userId: string | null;
}

/**
 * Module replacement for `vi.mock("@/lib/auth/session")`. `getSession` returns the `users` row
 * the state names, so a test changes who's signed in by writing `state.userId`.
 */
export function adminSessionModule(state: AdminSessionState) {
  return {
    getSession: async () => {
      if (!state.userId) return null;
      const [row] = await db.select().from(users).where(eq(users.id, state.userId)).limit(1);
      if (!row) return null;
      return { user: { id: row.id, name: row.name, email: row.email, admin: row.admin, organizationId: row.organizationId } };
    },
    requireSession: async () => null,
  };
}

/** What a test flips to choose the acting organization. Created with `vi.hoisted`. */
export interface DashboardSessionState {
  organizationId: string;
}

/**
 * Module replacement for `vi.mock("@/lib/dashboard/session")`, keeping every other export.
 * `overrides` changes one field of the session the guards return, such as the role.
 */
export function dashboardSessionModule<T extends typeof import("@/lib/dashboard/session")>(
  original: T,
  state: DashboardSessionState,
  overrides: Partial<DashboardSession> = {},
): T {
  const session = async (): Promise<DashboardSession> => ({
    organizationId: state.organizationId,
    userId: "usr_test",
    name: "Ada",
    email: "ada@example.com",
    role: ROLES.MEMBER,
    admin: false,
    timeZone: "UTC",
    emulating: null,
    ...overrides,
  });
  return { ...original, requireOrganization: session, requireOrganizationWrite: session };
}

/** A `FormData` from plain fields, for calling a server action. */
export function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

/** The second argument a dynamic route handler takes. */
export function routeContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** A JSON API request carrying a key's secret. `url` is the path, from the leading slash. */
export function apiRequest(secret: string, url: string, method = "GET", body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** An AWS SDK error, which the adapters read `name` and the HTTP status off. */
export function awsError(name: string, status: number, message = name): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status } });
}

/** The `messages` row, failing loudly rather than returning undefined. */
export async function messageRow(id: string): Promise<MessageRow> {
  const [found] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
  if (!found) throw new Error(`message ${id} disappeared`);
  return found;
}

/** The `providers` row, failing loudly rather than returning undefined. */
export async function providerRow(id: string): Promise<ProviderRow> {
  const [found] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
  if (!found) throw new Error(`provider ${id} disappeared`);
  return found;
}
