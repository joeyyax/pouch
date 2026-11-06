/**
 * Fills the development database with six months of realistic, reproducible history:
 * domains in every verification state, keys with different scopes and modes, messages across
 * the whole lifecycle with their events, lists and batches, inbound mail, addresses, webhooks,
 * suppressions and the activity log. Randomness is seeded and times are relative to now,
 * so every fill has the same shape and every metrics window has data.
 *
 * Development only. Nothing here runs in the app, and the app has no fixture path —
 * every screen reads these rows the same way it reads production ones.
 *
 *   pnpm dev:data [scenario]    fill: good, okay or bad (default bad)
 *   pnpm dev:data clear         remove messages and everything derived from them
 *   pnpm dev:data reset         remove everything this script made
 *   pnpm dev:data logos         point seeded layout logos at the hosted marks
 *   pnpm dev:reset [scenario]   reset, then fill
 *
 * good: every domain healthy, nothing waiting. okay: a domain on watch, a backlog, silent
 * sends, a dead webhook. bad: okay plus a stalled domain, a recent complaint and the
 * provider backing off right now.
 */
import "@/lib/env";
import { writeFile } from "node:fs/promises";
import { and, eq, inArray, like, ne, or } from "drizzle-orm";
import { closeDb, db } from "@/lib/db";
import {
  activity,
  addressForwardTargets,
  addresses,
  apiKeys,
  batches,
  domainUnsubscribes,
  domains,
  inboundMessages,
  listMemberships,
  lists,
  memberships,
  messageEvents,
  messages,
  organizations,
  providers,
  recipientHistory,
  reputationStates,
  suppressedRejections,
  suppressions,
  users,
  webhookAttempts,
  webhookDeliveries,
  webhookEndpoints,
  type MessageEventRow,
  type MessageRow,
} from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { generateKeySecret } from "@/lib/api/keys";
import { assignProvider } from "@/lib/providers/assignment";
import { createAccountWithPassword } from "@/lib/auth/provisioning";
import { ROLES, type OrgRole } from "@/lib/auth/permissions";
import type { DomainLayout } from "@/lib/domains/layout";
import { DEFAULT_STALL_LINES, type StallDetail, type StallReason } from "@/lib/domains/guard";
import { rate, RATE_FLOOR } from "@/lib/metrics/rates";
import { DEV_ACCOUNTS, DEV_PASSWORD, DEV_SECOND_ORGANIZATION, type DevAccountKey } from "@/lib/dev/seed-accounts";
import { newId } from "@/lib/ids";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { newStorageKey, writeBody } from "@/lib/storage/bodies";
import { bodyBytes } from "@/lib/messages/size";
import { domainFrames } from "@/lib/messages/rendered";
import { renderedBodyHash } from "@/lib/messages/bulk-detect";
import { sealLegacyInbound } from "@/lib/inbound/seal";
import { newMessageKey } from "@/lib/crypto";
import { searchProvider } from "@/lib/search";
import { reindex } from "@/lib/search/reindex";
import { readOrganizationReputation } from "@/lib/reputation/read";
import { closeRedis } from "@/lib/redis";
import type { ActivityActor } from "@/lib/activity/types";
import {
  CEDARVINE_TEMPLATES,
  FIELD_GUIDE,
  FIELDNOTES_TEMPLATES,
  HARBORLINE_RENEWAL,
  HARBORLINE_TEMPLATES,
  NORTHGATE_TEMPLATES,
  PRODUCT_UPDATE,
  RELEASE_NOTES,
  SCOPE_TEMPLATES,
  SCOPE_TEST_TEMPLATES,
  type Body,
} from "./dev-data/content";
import { DAY, History, HOUR, MINUTE, SECOND, type KeyRef, type Sender, type Stream } from "./dev-data/history";
import { ActivityLog, planInbound, planList, planWebhooks, SEEDED_ACTIVITY_PREFIX, type ListPlan } from "./dev-data/extras";
import { mulberry32 } from "./dev-data/random";
import { planAddresses } from "./dev-data/addresses";

const SEED = 20260929;

const SCENARIOS = ["good", "okay", "bad"] as const;
type Scenario = (typeof SCENARIOS)[number];
const ago = (ms: number) => new Date(Date.now() - ms);

/** Every domain this script makes. `example.org` is northgate.dev's earlier name. */
const DEV_DOMAINS = [
  "scope.example",
  "northgate.dev",
  "cedarvine.dev",
  "fieldnotes.app",
  "harborline.co",
  "market.example",
  "cedarvine.com",
  "example.org",
];

async function organizationId(): Promise<string> {
  // By slug, so leftover rows from a test run can't be picked instead.
  const slug = process.env.SEED_ORGANIZATION_SLUG ?? "default";
  const [row] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);
  if (!row) throw new Error(`No organization with slug "${slug}". Run \`pnpm seed\` first.`);
  return row.id;
}

async function secondOrganizationId(): Promise<string> {
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, DEV_SECOND_ORGANIZATION.slug))
    .limit(1);
  if (existing) return existing.id;

  const id = newId("organization");
  await db.insert(organizations).values({ id, name: DEV_SECOND_ORGANIZATION.name, slug: DEV_SECOND_ORGANIZATION.slug });
  console.log(`organization ${id} (${DEV_SECOND_ORGANIZATION.name})`);
  return id;
}

/**
 * Creates one dev account. `organizationId` here is only the deprecated required column on
 * `users`; it doesn't decide what the provider can reach.
 */
async function ensureDevUser(email: string, name: string, organizationId: string): Promise<string> {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return existing.id;

  const created = await createAccountWithPassword({
    email,
    name,
    organizationId,
    password: DEV_PASSWORD,
    emailVerified: true,
  });
  return created.id;
}

async function ensureMembership(userId: string, organizationId: string, role: OrgRole): Promise<void> {
  const [existing] = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  if (existing) return;
  await db.insert(memberships).values({ id: newId("membership"), userId, organizationId, role });
}

/**
 * The cast that makes both axes clickable: a service admin with no membership (the admin
 * screens, and emulation to get inside an organization), an owner and a plain member in the
 * primary dev org, and a member of a second org for the switcher. See `lib/dev/seed-accounts.ts`.
 */
async function seedDevUsers(primaryOrgId: string): Promise<void> {
  const secondOrgId = await secondOrganizationId();
  const spec = (key: DevAccountKey) => DEV_ACCOUNTS[key];

  const adminId = await ensureDevUser(spec("admin").email, spec("admin").name, primaryOrgId);
  await db.update(users).set({ admin: true }).where(eq(users.id, adminId));

  const ownerId = await ensureDevUser(spec("owner").email, spec("owner").name, primaryOrgId);
  await ensureMembership(ownerId, primaryOrgId, ROLES.OWNER);

  const memberId = await ensureDevUser(spec("member").email, spec("member").name, primaryOrgId);
  await ensureMembership(memberId, primaryOrgId, ROLES.MEMBER);

  // Belongs to both orgs — this is the provider the switcher actually has something to switch
  // between; the plain `member` above only ever sees the one.
  const member2Id = await ensureDevUser(spec("member2").email, spec("member2").name, secondOrgId);
  await ensureMembership(member2Id, primaryOrgId, ROLES.MEMBER);
  await ensureMembership(member2Id, secondOrgId, ROLES.MEMBER);

  console.log(`dev accounts: admin, owner, member, member2 — password "${DEV_PASSWORD}"`);
}

async function sesProvider(orgId: string): Promise<string> {
  const [existing] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(and(eq(providers.organizationId, orgId), eq(providers.name, "SES us-west-2")))
    .limit(1);
  if (existing) {
    // A backoff left by the worker or an earlier "bad" fill doesn't outlive the seed.
    await db.update(providers).set({ backoffUntil: null, backingOffSince: null }).where(eq(providers.id, existing.id));
    return existing.id;
  }

  const id = newId("provider");
  await db.insert(providers).values({
    id,
    organizationId: orgId,
    adapter: "ses",
    name: "SES us-west-2",
    credentials: encryptCredentials({
      accessKeyId: "AKIADEVELOPMENTONLY",
      secretAccessKey: "development-only-not-a-real-secret",
      region: "us-west-2",
    }),
    settings: { configurationSetName: "pouch-dev", topicArn: "arn:aws:sns:us-west-2:000000000000:dev", subscriptionConfirmed: "true" },
    concurrency: 8,
  });
  return id;
}

async function mailpaceProvider(orgId: string): Promise<string> {
  const [row] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(and(eq(providers.organizationId, orgId), eq(providers.adapter, "mailpace")))
    .limit(1);
  if (row) return row.id;

  // Created here rather than demanded of the admin: the fixtures need a second adapter to
  // show a domain moving between providers, and requiring a real Mailpace account to fill a
  // development database made `pnpm dev:data` unrunnable on a fresh clone.
  const id = newId("provider");
  await db.insert(providers).values({
    id,
    organizationId: orgId,
    adapter: "mailpace",
    name: "Mailpace",
    credentials: encryptCredentials({
      serverToken: "development-only-not-a-real-token",
      organizationToken: "development-only-not-a-real-token",
    }),
    settings: { webhookPublicKey: "ZGV2ZWxvcG1lbnQtb25seS1ub3QtYS1yZWFsLWtleQ==" },
    concurrency: 4,
  });
  return id;
}

interface DomainSpec {
  name: string;
  status: "verified" | "pending" | "failed";
  providerId: string;
  records: ProposedDnsRecord[];
  missing?: ProposedDnsRecord[];
  errors?: string[];
  layout?: DomainLayout;
  verifiedAgo?: number;
  checkedAgo?: number;
  createdAgo?: number;
  inboundRetentionDays?: number;
  bulk?: boolean;
}

async function upsertDomain(orgId: string, spec: DomainSpec): Promise<string> {
  const values = {
    organizationId: orgId,
    providerId: spec.providerId,
    name: spec.name,
    status: spec.status,
    providerDomainId: `dev-${spec.name}`,
    dnsRecords: spec.records,
    missingRecords: spec.missing ?? [],
    verificationErrors: spec.errors ?? [],
    layout: spec.layout ?? null,
    verifiedAt: spec.verifiedAgo === undefined ? null : ago(spec.verifiedAgo),
    lastCheckedAt: spec.checkedAgo === undefined ? null : ago(spec.checkedAgo),
    inboundEnabled: spec.inboundRetentionDays !== undefined,
    inboundRetentionDays: spec.inboundRetentionDays ?? 7,
    bulkAllowed: spec.bulk ?? false,
    // A stall left by the guard or the UI doesn't outlive the seed; fill sets the one it wants.
    stalledAt: null,
    stallReason: null,
    stallDetail: null,
    stallCheckedAt: null,
    createdAt: ago(spec.createdAgo ?? 30 * DAY),
    updatedAt: new Date(),
  };

  const [existing] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.organizationId, orgId), eq(domains.name, spec.name)))
    .limit(1);

  if (existing) {
    await db.update(domains).set(values).where(eq(domains.id, existing.id));
    return existing.id;
  }

  const id = newId("domain");
  await db.insert(domains).values({ id, ...values });
  return id;
}

interface KeySpec {
  name: string;
  mode: "live" | "test";
  domainIds: string[];
  rateLimit: number;
  createdAgo: number;
  revokedAgo?: number;
  /** For a key that calls the API but never sends. Otherwise its newest message decides. */
  lastUsedAgo?: number;
}

/** Straight to the table: `createApiKey` mails a key-created alert, which would queue real sends. */
async function upsertKey(orgId: string, spec: KeySpec): Promise<KeyRef> {
  const dates = {
    domainIds: spec.domainIds,
    rateLimit: spec.rateLimit,
    createdAt: ago(spec.createdAgo),
    lastUsedAt: spec.lastUsedAgo === undefined ? null : ago(spec.lastUsedAgo),
    revokedAt: spec.revokedAgo === undefined ? null : ago(spec.revokedAgo),
    revokedReason: null,
  };
  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.organizationId, orgId), eq(apiKeys.name, spec.name)))
    .limit(1);

  // An existing key gets its dates put back, so a revoke through the UI doesn't outlive the seed.
  if (existing) {
    await db.update(apiKeys).set(dates).where(eq(apiKeys.id, existing.id));
    return { id: existing.id, name: spec.name };
  }

  const generated = generateKeySecret(spec.mode);
  const id = newId("key");
  await db.insert(apiKeys).values({
    id,
    organizationId: orgId,
    name: spec.name,
    secretHash: generated.secretHash,
    secretPrefix: generated.secretPrefix,
    mode: generated.mode,
    ...dates,
  });
  return { id, name: spec.name };
}

async function devDomainIds(orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.organizationId, orgId), inArray(domains.name, DEV_DOMAINS)));
  return rows.map((row) => row.id);
}

async function clearMessages(orgId: string): Promise<void> {
  // design:flows leaves `flow-` rows behind on purpose; this is where they go.
  await db.delete(apiKeys).where(and(eq(apiKeys.organizationId, orgId), like(apiKeys.name, "flow-%")));
  await db.delete(suppressions).where(eq(suppressions.organizationId, orgId));
  await db.delete(recipientHistory).where(eq(recipientHistory.organizationId, orgId));
  await db.delete(suppressedRejections).where(eq(suppressedRejections.organizationId, orgId));
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.organizationId, orgId));
  await db.delete(inboundMessages).where(eq(inboundMessages.organizationId, orgId));
  await db.delete(addresses).where(eq(addresses.organizationId, orgId));
  await db.delete(messageEvents).where(eq(messageEvents.organizationId, orgId));
  await db.delete(messages).where(eq(messages.organizationId, orgId));
  await db.delete(batches).where(eq(batches.organizationId, orgId));
  await db.delete(activity).where(and(eq(activity.organizationId, orgId), like(activity.id, `${SEEDED_ACTIVITY_PREFIX}%`)));

  const search = searchProvider();
  if (search.mode !== "postgres") await search.removeOrganization(orgId);
  console.log("messages, events, suppressions, inbound, addresses and their history cleared");
}

/** Lists, endpoints and per-domain rows the fill recreates rather than upserts. */
async function clearSetup(orgId: string, domainIds: string[], keyIds: string[]): Promise<void> {
  if (domainIds.length > 0) {
    await db.delete(lists).where(and(eq(lists.organizationId, orgId), inArray(lists.domainId, domainIds)));
    await db.delete(domainUnsubscribes).where(and(eq(domainUnsubscribes.organizationId, orgId), inArray(domainUnsubscribes.domainId, domainIds)));
    await db.delete(reputationStates).where(and(eq(reputationStates.organizationId, orgId), inArray(reputationStates.subjectId, domainIds)));
  }
  const owners = [
    ...(domainIds.length > 0 ? [inArray(webhookEndpoints.domainId, domainIds)] : []),
    ...(keyIds.length > 0 ? [inArray(webhookEndpoints.apiKeyId, keyIds)] : []),
  ];
  if (owners.length > 0) await db.delete(webhookEndpoints).where(and(eq(webhookEndpoints.organizationId, orgId), or(...owners)));
}

async function reset(orgId: string): Promise<void> {
  await clearMessages(orgId);
  await clearSetup(orgId, await devDomainIds(orgId), []);
  await db.delete(apiKeys).where(and(eq(apiKeys.organizationId, orgId), ne(apiKeys.name, "bootstrap")));
  await db.delete(domains).where(and(eq(domains.organizationId, orgId), inArray(domains.name, DEV_DOMAINS)));
  const [ses] = await db
    .select({ id: providers.id })
    .from(providers)
    .where(and(eq(providers.organizationId, orgId), eq(providers.name, "SES us-west-2")));
  if (ses) {
    await db.update(organizations).set({ providerId: null }).where(and(eq(organizations.id, orgId), eq(organizations.providerId, ses.id)));
    await db.delete(providers).where(eq(providers.id, ses.id));
  }
  console.log("development rows removed");
}

/** Chunked inserts: one round trip per `size` rows. */
async function chunked<T>(rows: T[], size: number, write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

async function parallel<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
}

const SCOPE_HTML = `<h1 style="font:600 20px system-ui;margin:0 0 12px">You're invited to Blue Harbor</h1>
<p style="margin:0 0 12px">Ada added you to the Scope workspace for Blue Harbor. Your invite is good for seven days.</p>
<p style="margin:0"><a href="https://scope.example/invite/8f3c21ab" style="color:#1d46f5">Open Scope</a></p>`;

const DIGEST_HTML = `<h1 style="font:600 20px system-ui;margin:0 0 12px">Blue Harbor, week of 1 September</h1>
<p style="margin:0 0 12px">4 deploys, 2 incidents, 1 open review.</p>
<p style="margin:0"><a href="https://scope.example/digest/2026-w36" style="color:#1d46f5">Read the full digest</a></p>`;

const MANUAL_REASONS = [
  "Asked to be removed by phone.",
  "Requested through support ticket 4821.",
  "Role address, not a person.",
  "Customer closed their account.",
  "Legal asked us to stop contacting this address.",
  "Shared inbox that forwards to a list.",
  "Duplicate account; the other address is current.",
  "Asked to be removed at the trade show.",
  "Bounced from our old provider before the move.",
];

async function fill(orgId: string, scenario: Scenario): Promise<void> {
  const calm = scenario === "good";
  const bad = scenario === "bad";
  const started = Date.now();
  // Messages aren't upserted, so a second run would double the list.
  await clearMessages(orgId);
  const random = mulberry32(SEED);
  const now = Date.now();
  const ses = await sesProvider(orgId);
  const mailpace = await mailpaceProvider(orgId);
  // The organization's default provider, unless one is already set.
  await assignProvider(ses, orgId, { type: "worker", id: null, label: "Development data" });

  const [org] = await db.select({ retention: organizations.bodyRetentionDays }).from(organizations).where(eq(organizations.id, orgId));
  const retentionDays = org?.retention ?? 45;

  const scope = await upsertDomain(orgId, {
    name: "scope.example",
    status: "verified",
    providerId: ses,
    records: [
      { type: "CNAME", name: "abc123._domainkey.scope.example", value: "abc123.dkim.amazonses.com", required: true },
      { type: "CNAME", name: "def456._domainkey.scope.example", value: "def456.dkim.amazonses.com", required: true },
      { type: "MX", name: "mail.scope.example", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false },
      { type: "TXT", name: "mail.scope.example", value: "v=spf1 include:amazonses.com ~all", required: false },
      { type: "MX", name: "inbound.scope.example", value: "inbound-smtp.us-west-2.amazonaws.com", priority: 10, required: false },
    ],
    verifiedAgo: 240 * DAY,
    checkedAgo: 2 * MINUTE,
    createdAgo: 240 * DAY,
    inboundRetentionDays: 30,
    bulk: true,
    layout: {
      brandName: "Scope",
      logoUrl: devLogo("scope-mark.png"),
      accent: "#1d46f5",
      footer: "Scope · Portland, OR",
    },
  });

  // Real domain, real DNS, both directions of the missing/live disagreement:
  //
  // - MAIL FROM's MX and TXT are real, live values — SES has confirmed DKIM but not yet
  //   MAIL FROM, so these two optional records sit in missingRecords while actually resolving
  //   (#197's reassuring case).
  // - The DKIM CNAMEs use ohmysmtp._domainkey and resend._domainkey — real TXT records left
  //   over from providers this domain has since moved off. SES's own DKIM record is a CNAME,
  //   so a live check here genuinely fails (wrong record type, not just a stale value), while
  //   SES's last answer still has them confirmed — the alarming case: required records the
  //   provider found before and can't find now.
  const northgate = await upsertDomain(orgId, {
    name: "northgate.dev",
    status: "verified",
    providerId: ses,
    records: [
      { type: "CNAME", name: "ohmysmtp._domainkey.northgate.dev", value: "dev1a.dkim.amazonses.com", required: true },
      { type: "CNAME", name: "resend._domainkey.northgate.dev", value: "dev2b.dkim.amazonses.com", required: true },
      { type: "MX", name: "mail.northgate.dev", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false },
      { type: "TXT", name: "mail.northgate.dev", value: "v=spf1 include:amazonses.com ~all", required: false },
    ],
    missing: [
      { type: "MX", name: "mail.northgate.dev", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false },
      { type: "TXT", name: "mail.northgate.dev", value: "v=spf1 include:amazonses.com ~all", required: false },
    ],
    verifiedAgo: 2 * HOUR,
    checkedAgo: 5 * MINUTE,
    createdAgo: 3 * HOUR,
  });

  const cedarvineDev = await upsertDomain(orgId, {
    name: "cedarvine.dev",
    status: "verified",
    providerId: mailpace,
    records: [
      { type: "CNAME", name: "jy1a2b._domainkey.cedarvine.dev", value: "jy1a2b.dkim.mailpace.com", required: true },
      { type: "TXT", name: "cedarvine.dev", value: "v=spf1 include:mailpace.com ~all", required: false },
      { type: "MX", name: "inbound.cedarvine.dev", value: "inbound.mailpace.com", priority: 10, required: false },
    ],
    verifiedAgo: (retentionDays + 60) * DAY,
    checkedAgo: 6 * MINUTE,
    createdAgo: (retentionDays + 60) * DAY,
    inboundRetentionDays: 7,
  });

  const fieldnotes = await upsertDomain(orgId, {
    name: "fieldnotes.app",
    status: "verified",
    providerId: ses,
    records: [
      { type: "CNAME", name: "fn9k2m._domainkey.fieldnotes.app", value: "fn9k2m.dkim.amazonses.com", required: true },
      { type: "CNAME", name: "fn4p7q._domainkey.fieldnotes.app", value: "fn4p7q.dkim.amazonses.com", required: true },
      { type: "MX", name: "mail.fieldnotes.app", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false },
      { type: "TXT", name: "mail.fieldnotes.app", value: "v=spf1 include:amazonses.com ~all", required: false },
    ],
    verifiedAgo: 195 * DAY,
    checkedAgo: 4 * MINUTE,
    createdAgo: 195 * DAY,
    bulk: true,
    layout: { brandName: "Fieldnotes", logoUrl: devLogo("fieldnotes-mark.png"), accent: "#2f7d4a", footer: "Fieldnotes · Bend, OR" },
  });

  const harborline = await upsertDomain(orgId, {
    name: "harborline.co",
    status: "verified",
    providerId: mailpace,
    records: [
      { type: "CNAME", name: "hb3c5d._domainkey.harborline.co", value: "hb3c5d.dkim.mailpace.com", required: true },
      { type: "TXT", name: "harborline.co", value: "v=spf1 include:mailpace.com ~all", required: false },
    ],
    verifiedAgo: 51 * DAY,
    checkedAgo: 7 * MINUTE,
    createdAgo: 52 * DAY,
  });

  const moc = await upsertDomain(orgId, {
    name: "market.example",
    status: "pending",
    providerId: mailpace,
    records: [
      { type: "CNAME", name: "mp1._domainkey.market.example", value: "mp1.dkim.mailpace.com", required: true },
      { type: "CNAME", name: "mp2._domainkey.market.example", value: "mp2.dkim.mailpace.com", required: true },
      { type: "TXT", name: "market.example", value: "v=spf1 include:mailpace.com ~all", required: false },
      { type: "TXT", name: "_dmarc.market.example", value: "v=DMARC1; p=none; rua=mailto:dmarc@market.example", required: false },
    ],
    missing: [
      { type: "CNAME", name: "mp2._domainkey.market.example", value: "mp2.dkim.mailpace.com", required: true },
      { type: "TXT", name: "_dmarc.market.example", value: "v=DMARC1; p=none; rua=mailto:dmarc@market.example", required: false },
    ],
    checkedAgo: 8 * MINUTE,
    createdAgo: 15 * MINUTE,
  });

  const cedarvine = await upsertDomain(orgId, {
    name: "cedarvine.com",
    status: "failed",
    providerId: ses,
    records: [
      { type: "CNAME", name: "cv7x8y._domainkey.cedarvine.com", value: "cv7x8y.dkim.amazonses.com", required: true },
      { type: "TXT", name: "mail.cedarvine.com", value: "v=spf1 include:amazonses.com ~all", required: false },
    ],
    missing: [
      { type: "CNAME", name: "cv7x8y._domainkey.cedarvine.com", value: "cv7x8y.dkim.amazonses.com", required: true },
      { type: "TXT", name: "mail.cedarvine.com", value: "v=spf1 include:amazonses.com ~all", required: false },
    ],
    errors: ["DKIM record not found for cv7x8y._domainkey.cedarvine.com."],
    checkedAgo: 3 * HOUR,
    createdAgo: 9 * DAY,
  });

  const keySpecs: Record<string, KeySpec> = {
    scopeProd: { name: "scope-production", mode: "live", domainIds: [scope], rateLimit: 200, createdAgo: 115 * DAY },
    scopeStaging: { name: "scope-staging", mode: "test", domainIds: [scope], rateLimit: 3000, createdAgo: 200 * DAY },
    scopeLegacy: { name: "scope-legacy", mode: "live", domainIds: [scope], rateLimit: 60, createdAgo: 240 * DAY, revokedAgo: 68 * DAY },
    siteKey: { name: "cedarvineDev-site", mode: "live", domainIds: [cedarvineDev], rateLimit: 3000, createdAgo: (retentionDays + 60) * DAY },
    mocKey: { name: "moc-reservations", mode: "live", domainIds: [moc, cedarvineDev], rateLimit: 3000, createdAgo: 14 * MINUTE },
    fieldnotesApp: { name: "fieldnotes-app", mode: "live", domainIds: [fieldnotes], rateLimit: 600, createdAgo: 195 * DAY },
    newsletter: { name: "fieldnotes-newsletter", mode: "live", domainIds: [fieldnotes], rateLimit: 3000, createdAgo: 172 * DAY },
    harborlineKey: { name: "harborline-bookings", mode: "live", domainIds: [harborline], rateLimit: 300, createdAgo: 51 * DAY },
    northgateKey: { name: "northgate-onboarding", mode: "live", domainIds: [northgate], rateLimit: 3000, createdAgo: 2 * HOUR },
    opsKey: { name: "ops-alerts", mode: "live", domainIds: [], rateLimit: 60, createdAgo: 230 * DAY },
    ciKey: { name: "ci-smoke", mode: "test", domainIds: [], rateLimit: 3000, createdAgo: 120 * DAY, lastUsedAgo: 6 * DAY + 3 * HOUR },
  };
  const keys: Record<string, KeyRef> = {};
  for (const [name, spec] of Object.entries(keySpecs)) keys[name] = await upsertKey(orgId, spec);
  const k = (name: string) => keys[name]!;

  const ourDomainIds = await devDomainIds(orgId);
  await clearSetup(orgId, ourDomainIds, Object.values(keys).map((key) => key.id));

  const owner = await userActor(DEV_ACCOUNTS.owner.email);
  const member = await userActor(DEV_ACCOUNTS.member.email);

  const senders: Record<string, Sender> = {
    scope: { id: scope, name: "scope.example", providerId: ses, adapter: "ses" },
    cedarvine: { id: cedarvineDev, name: "cedarvine.dev", providerId: mailpace, adapter: "mailpace" },
    fieldnotes: { id: fieldnotes, name: "fieldnotes.app", providerId: ses, adapter: "ses" },
    harborline: { id: harborline, name: "harborline.co", providerId: mailpace, adapter: "mailpace" },
    northgate: { id: northgate, name: "northgate.dev", providerId: ses, adapter: "ses" },
  };
  const s = (name: string) => senders[name]!;

  const history = new History(random, orgId, now);
  const blastAt = history.dayStart(2) + 17 * HOUR + 10 * MINUTE;
  const stalledAt = blastAt + 38 * MINUTE;

  const scopeStream: Stream = {
    domain: s("scope"),
    templates: SCOPE_TEMPLATES,
    keys: [
      { key: k("scopeLegacy"), weight: 100, until: 112 },
      { key: k("scopeProd"), weight: 100, since: 112 },
      { key: k("opsKey"), weight: 1 },
    ],
    perDay: 54,
    growth: 0.6,
    weekend: 0.35,
    startDay: 179,
    newRate: 0.22,
    badRate: 0.015,
  };
  const testStream: Stream = { ...scopeStream, templates: SCOPE_TEST_TEMPLATES, keys: [{ key: k("scopeStaging"), weight: 1 }], perDay: 4, growth: 0.3, weekend: 0.1, newRate: 0, badRate: 0, testMode: true };
  const cedarvineStream: Stream = {
    domain: s("cedarvine"),
    templates: CEDARVINE_TEMPLATES,
    keys: [{ key: k("siteKey"), weight: 1 }],
    perDay: 22,
    growth: 0.4,
    weekend: 1.15,
    startDay: 179,
    newRate: 0.3,
    badRate: 0.01,
    silentRate: calm ? 0 : 0.0015,
  };
  const fieldnotesStream: Stream = {
    domain: s("fieldnotes"),
    templates: FIELDNOTES_TEMPLATES,
    keys: [{ key: k("fieldnotesApp"), weight: 1 }],
    perDay: 10,
    growth: 1,
    weekend: 0.8,
    startDay: 179,
    newRate: 0.4,
    badRate: 0.007,
  };
  const newsletterStream: Stream = { ...fieldnotesStream, keys: [{ key: k("newsletter"), weight: 1 }], perDay: 0 };
  const harborlineStream: Stream = {
    domain: s("harborline"),
    templates: HARBORLINE_TEMPLATES,
    keys: [{ key: k("harborlineKey"), weight: 1 }],
    perDay: 6,
    growth: 0.2,
    weekend: 1.3,
    startDay: 50,
    newRate: 0.35,
    badRate: 0.03,
    heldFrom: bad ? stalledAt : undefined,
  };
  const northgateStream: Stream = { domain: s("northgate"), templates: NORTHGATE_TEMPLATES, keys: [{ key: k("northgateKey"), weight: 1 }], perDay: 0, growth: 0, weekend: 1, startDay: 0, newRate: 1, badRate: 0 };

  // Busiest at the end of the pool, so the bounce address comes first.
  history.seedPool(testStream, ["bounce+1@scope.example", ...Array.from({ length: 23 }, (_, i) => `qa+${i + 1}@scope.example`)]);

  // Landmarks: the rows the screenshot pass addresses by name.
  const landmarks: Record<string, string> = {
    scope: scope,
    cedarvineDev,
    fieldnotes,
    harborline,
    northgate,
    moc,
    cedarvine,
    scopeProd: k("scopeProd").id,
    scopeStaging: k("scopeStaging").id,
    siteKey: k("siteKey").id,
  };

  landmarks.bounced = history.explicit({
    domain: s("cedarvine"),
    key: k("siteKey"),
    status: "bounced",
    from: "billing@cedarvine.dev",
    fromName: "Ada Park",
    to: "old-address@cedarvine.com",
    subject: "Invoice 2041",
    createdAgo: 84 * MINUTE,
    body: {
      html: "<p>Invoice 2041 is attached.</p><p>Due 2026-09-30. Reply to this message with any questions.</p>",
      text: "Invoice 2041 is attached.\n\nDue 2026-09-30. Reply to this message with any questions.",
    },
    attachment: { filename: "invoice-2041.pdf", contentType: "application/pdf", kilobytes: 84 },
    providerMessageId: "mp_2a55de7101",
    events: [
      ["queued", null, 84 * MINUTE],
      ["sent", null, 84 * MINUTE - 1000],
      ["bounced", "550 5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos or unnecessary spaces.", 84 * MINUTE - 5000],
    ],
  });

  // Nine days back: complaints inside the guard's week would stall a healthy domain.
  landmarks.complained = history.explicit({
    domain: s("scope"),
    key: k("scopeProd"),
    status: "complained",
    from: "hi@scope.example",
    fromName: "Scope",
    to: "marketing@riverstone.health",
    subject: "Monthly summary",
    createdAgo: 9 * DAY + 6 * HOUR,
    body: { html: "<p>Your Scope summary for August.</p>", text: "Your Scope summary for August." },
    providerMessageId: "0100019218ab77e1-64ba1130-ses",
    events: [
      ["queued", null, 9 * DAY + 6 * HOUR],
      ["sent", null, 9 * DAY + 6 * HOUR - 2000],
      ["delivered", null, 9 * DAY + 6 * HOUR - 9000],
      ["complained", "abuse", 9 * DAY],
    ],
  });

  landmarks.delivered = history.explicit({
    domain: s("scope"),
    key: k("scopeProd"),
    status: "delivered",
    from: "hi@scope.example",
    fromName: "Scope",
    to: "name@example.com",
    // A send takes a list, so one row has to carry cc and bcc for the screens that show them.
    cc: ["team@blueharbor.co", "ops@northgate.io"],
    bcc: ["audit@scope.example"],
    subject: "Your Scope invite",
    createdAgo: 4 * MINUTE,
    body: {
      html: SCOPE_HTML,
      text: "Ada added you to the Scope workspace for Blue Harbor. Your invite is good for seven days.\n\nOpen Scope → https://scope.example/invite/8f3c21ab",
    },
    layout: true,
    tags: ["invite", "blue-harbor"],
    providerMessageId: "0100019218ab77e1-3c8f4a12-ses",
    events: [
      ["queued", null, 4 * MINUTE],
      ["sent", null, 4 * MINUTE - 1000],
      ["delivered", null, 4 * MINUTE - 4000],
    ],
  });

  landmarks.deferred = history.explicit({
    domain: s("scope"),
    key: k("scopeProd"),
    status: "deferred",
    from: "hi@scope.example",
    fromName: "Scope",
    to: "ops@blueharbor.co",
    subject: "Weekly digest",
    createdAgo: 22 * MINUTE,
    body: { html: DIGEST_HTML, text: "4 deploys, 2 incidents, 1 open review.\n\nRead the full digest → https://scope.example/digest/2026-w36" },
    layout: true,
    tags: ["digest"],
    providerMessageId: "0100019218ab77e1-7b21c904-ses",
    events: [
      ["queued", null, 22 * MINUTE],
      ["sent", null, 22 * MINUTE - 4000],
      ["deferred", "451 4.3.0 Mail server temporarily rejected message.", 14 * MINUTE],
      ["deferred", "451 4.3.0 Mail server temporarily rejected message.", 3 * MINUTE],
    ],
  });

  if (!calm) landmarks.sent = history.explicit({
    domain: s("cedarvine"),
    key: k("siteKey"),
    status: "sent",
    from: "hello@cedarvine.dev",
    fromName: "Ada Park",
    to: "hello@northgate.io",
    subject: "Password reset",
    createdAgo: 115 * MINUTE,
    body: {
      html: '<p>Reset your password → <a href="https://cedarvine.dev/reset/9c1f">cedarvine.dev/reset</a></p><p>The link is good for one hour.</p>',
      text: "Reset your password → https://cedarvine.dev/reset/9c1f\n\nThe link is good for one hour.",
    },
    providerMessageId: "mp_2a55de7102",
    events: [
      ["queued", null, 115 * MINUTE],
      ["sent", null, 115 * MINUTE - 2000],
    ],
  });

  landmarks.failed = history.explicit({
    domain: s("scope"),
    key: k("scopeProd"),
    status: "failed",
    from: "billing@scope.example",
    fromName: "Scope billing",
    to: "team@widgetworks.com",
    subject: "Receipt for order 8812",
    createdAgo: 25 * HOUR,
    body: { html: "<p>Thanks — your order 8812 is confirmed.</p>", text: "Thanks — your order 8812 is confirmed." },
    attempts: 5,
    events: [
      ["queued", null, 25 * HOUR],
      ["failed", "554 5.7.1 Message rejected: sending domain is not authorized for this recipient.", 24 * HOUR],
    ],
  });

  if (!calm) landmarks.queued = history.explicit({
    domain: s("cedarvine"),
    key: k("siteKey"),
    status: "queued",
    from: "hello@cedarvine.dev",
    fromName: "Ada Park",
    to: "dev@blueharbor.co",
    subject: "Deploy finished",
    createdAgo: 20 * SECOND,
    body: { html: "<p>blueharbor-web deployed to production in 42s.</p>", text: "blueharbor-web deployed to production in 42s." },
    attempts: 0,
    events: [["queued", null, 20 * SECOND]],
  });

  // The one place the dashboard admits a problem on our side.
  if (!calm) landmarks.stuck = history.explicit({
    domain: s("scope"),
    key: k("scopeProd"),
    status: "queued",
    from: "reports@scope.example",
    fromName: "Scope",
    to: "sam@blueharbor.co",
    subject: "Your Blue Harbor report is ready",
    createdAgo: 12 * MINUTE,
    body: {
      html: '<p>Your Blue Harbor report is ready.</p><p><a href="https://scope.example/reports/8f3c">Open it</a></p>',
      text: "Your Blue Harbor report is ready.\n\nOpen it → https://scope.example/reports/8f3c",
    },
    attempts: 0,
    events: [["queued", null, 12 * MINUTE]],
  });

  landmarks.test = history.explicit({
    domain: s("scope"),
    key: k("scopeStaging"),
    status: "delivered",
    from: "hi@scope.example",
    fromName: "Scope",
    to: "qa@example.net",
    subject: "Invite (staging)",
    createdAgo: 30 * HOUR,
    body: { html: SCOPE_HTML, text: "Ada added you to the Scope workspace." },
    testMode: true,
    providerMessageId: "mock_7fa2c01b9e",
    events: [
      ["queued", null, 30 * HOUR],
      ["sent", null, 30 * HOUR - 500],
      ["delivered", null, 30 * HOUR - 1500],
    ],
  });

  // A body past retention: the row and its events stay, the body is gone.
  const expiredAgo = (retentionDays + 12) * DAY;
  landmarks.expired = history.explicit({
    domain: s("cedarvine"),
    key: k("siteKey"),
    status: "delivered",
    from: "hello@cedarvine.dev",
    fromName: "Ada Park",
    to: "archive@northgate.io",
    subject: "Welcome to Northgate",
    createdAgo: expiredAgo,
    body: { html: null, text: null },
    bodyExpired: true,
    providerMessageId: "mp_old0001aa",
    events: [
      ["queued", null, expiredAgo],
      ["sent", null, expiredAgo - 2000],
      ["delivered", null, expiredAgo - 8000],
    ],
  });

  // One complaint inside the guard's week is enough to put scope.example on course to stall.
  if (bad) {
    landmarks.recentComplaint = history.explicit({
      domain: s("scope"),
      key: k("scopeProd"),
      status: "complained",
      from: "hi@scope.example",
      fromName: "Scope",
      to: "priya.okafor@riverstone.health",
      subject: "Riverstone, your weekly digest",
      createdAgo: 2 * DAY + 5 * HOUR,
      body: SCOPE_TEMPLATES.find((template) => template.key === "scope-digest")!.body("Priya"),
      layout: true,
      tags: ["digest"],
      providerMessageId: "0100019218ab77e1-5d3f9a60-ses",
      events: [
        ["queued", null, 2 * DAY + 5 * HOUR],
        ["sent", null, 2 * DAY + 5 * HOUR - 1500],
        ["delivered", null, 2 * DAY + 5 * HOUR - 6000],
        ["complained", "abuse", 2 * DAY],
      ],
    });
  }

  // A typo on a brand-new domain's first sends: a "watch" standing.
  if (!calm) landmarks.firstBounce = history.explicit({
    domain: s("northgate"),
    key: k("northgateKey"),
    status: "bounced",
    from: "hello@northgate.dev",
    fromName: "Northgate",
    to: "jon.smiht@gmial.com",
    subject: "Welcome to Northgate",
    createdAgo: 95 * MINUTE,
    body: NORTHGATE_TEMPLATES[0]!.body("Jon"),
    tags: ["onboarding"],
    providerMessageId: "0100019218ab77e1-9e04d2c7-ses",
    bounceType: "Permanent/General",
    events: [
      ["queued", null, 95 * MINUTE],
      ["sent", null, 95 * MINUTE - 900],
      ["bounced", "550 5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient's email address for typos or unnecessary spaces.", 95 * MINUTE - 3200],
    ],
  });

  history.suppressDirect({ address: "bounced@example.com", reason: "hard_bounce", detail: "550 5.1.1 User unknown.", at: now - 25 * DAY });
  const doNotMail = history.suppressDirect({ address: "do-not-mail@northgate.io", reason: "manual", detail: "Asked to be removed by phone.", at: now - 37 * DAY });
  landmarks.suppression = doNotMail;

  // An old list brought over from Postmark.
  const importedAt = history.dayStart(150) + 18 * HOUR;
  for (let i = 0; i < 80; i += 1) {
    history.suppressDirect({ address: history.address(0), reason: "hard_bounce", detail: "Imported from Postmark: HardBounce", source: "postmark", at: importedAt + i * 30 });
  }

  // Lists before the schedule, so their members are the audience transactional mail reaches too.
  const listPlans: ListPlan[] = [
    planList(history, random, orgId, {
      domain: s("fieldnotes"),
      name: "Field guide",
      doubleOptIn: true,
      createdDay: 88,
      imported: 0,
      signups: 300,
      unsubscribeRate: 0.08,
      manual: 4,
      batch: { template: FIELD_GUIDE, days: Array.from({ length: 12 }, (_, i) => 3 + i * 7).reverse(), key: k("newsletter"), stream: newsletterStream },
    }, owner.label),
    planList(history, random, orgId, {
      domain: s("fieldnotes"),
      name: "Product updates",
      doubleOptIn: false,
      createdDay: 170,
      imported: 260,
      signups: 140,
      unsubscribeRate: 0.1,
      manual: 6,
      batch: { template: PRODUCT_UPDATE, days: [162, 132, 102, 72, 42, 12], key: k("newsletter"), stream: newsletterStream },
    }, owner.label),
    planList(history, random, orgId, {
      domain: s("scope"),
      name: "Release notes",
      doubleOptIn: true,
      createdDay: 130,
      imported: 0,
      signups: 130,
      unsubscribeRate: 0.05,
      manual: 2,
      batch: { template: RELEASE_NOTES, days: [110, 55, 20], key: k("scopeProd"), stream: scopeStream },
    }, member.label),
  ];
  history.seedPool(fieldnotesStream, listPlans.slice(0, 2).flatMap((plan) => plan.members.filter((m) => m.source === "api").map((m) => m.address)));

  const digest = SCOPE_TEMPLATES.find((template) => template.key === "scope-digest")!;
  history.schedule(scopeStream, { extra: (day, weekday) => (weekday === 1 ? { template: digest, count: Math.round(18 * (1 - day / 400)) } : null) });
  history.schedule(testStream);
  history.schedule(cedarvineStream);
  history.schedule(fieldnotesStream);
  history.schedule(harborlineStream);

  // A customer imported a stale contact list and invited all of it.
  const invite = SCOPE_TEMPLATES.find((template) => template.key === "scope-invite")!;
  const spikeAt = history.dayStart(midweek(history, 64)) + 17 * HOUR;
  for (let i = 0; i < 140; i += 1) history.send(scopeStream, spikeAt + i * random.int(20, 60) * SECOND, invite, { stale: 0.22 });

  // harborline.co mailed a years-old renewal list; the guard stalled it 38 minutes later.
  if (bad) for (let i = 0; i < 260; i += 1) history.send(harborlineStream, blastAt + i * random.int(3, 6) * SECOND, HARBORLINE_RENEWAL, { stale: 0.2 });

  for (let i = 0; i < 14; i += 1) history.send(northgateStream, now - random.int(5 * MINUTE, 110 * MINUTE), NORTHGATE_TEMPLATES[0]!);

  // A provider throttle and Gmail rate limit on one afternoon, Mailpace 503s on another.
  const throttleDay = midweek(history, 38);
  history.incident(scope, history.dayStart(throttleDay) + 15 * HOUR, history.dayStart(throttleDay) + 21 * HOUR, { throttle: true, gmailDefer: true });
  if (!calm) history.incident(cedarvineDev, history.dayStart(3) + 16 * HOUR, history.dayStart(3) + 19 * HOUR + 30 * MINUTE, { retry: true });
  if (!calm) history.silence(cedarvineDev, now - 20 * HOUR, now - 65 * MINUTE, 4);

  // Retrying right now.
  const signIn = SCOPE_TEMPLATES[0]!;
  if (!calm) for (const secondsAgo of [45, 80, 120, 170]) history.send(scopeStream, now - secondsAgo * SECOND, signIn, { incident: { retry: true } });

  MANUAL_REASONS.forEach((detail, i) => history.manual(now - (8 + i * 17) * DAY - random.int(0, 8) * HOUR, detail));

  const result = history.run();

  // Stall detail from the numbers the guard would have seen.
  const stall = stallDetail(result.messages, harborline, stalledAt);

  // Bodies: a few hundred rows get their own; the rest in retention share their template's.
  const retentionMs = retentionDays * DAY;
  const shreddedByDay = new Map<number, number>();
  const bodyEvents: MessageEventRow[] = [];
  const recent = result.messages
    .filter((m) => !m.batchId && m.createdAt.getTime() > now - retentionMs)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 200);
  const unique = new Set([...result.landmarks, ...recent.map((m) => m.id)]);
  const sharedKeys = new Map<string, { storageKey: string; key: Buffer; encoded: string; body: Body; attachment?: { filename: string; contentType: string; kilobytes: number } }>();
  const writes: { storageKey: string; key: Buffer; body: Body; attachment?: { filename: string; contentType: string; kilobytes: number } }[] = [];

  const frames = await domainFrames(orgId, [...new Set(result.messages.map((m) => m.domainId))]);
  const hashOf = (message: MessageRow, body: Body) => {
    const frame = frames.get(message.domainId);
    return renderedBodyHash(body.html, body.text, message.layout, frame?.layout ?? null, frame?.name ?? "", message.layoutOverrides);
  };

  const sizeOf = (message: MessageRow, body: Body, attachment?: { kilobytes: number }) => {
    message.bodyBytes = bodyBytes(body.html, body.text);
    message.attachmentBytes = message.envelope.attachmentCount > 0 && attachment ? Math.round(attachment.kilobytes * 1024) : 0;
  };

  for (const message of result.messages) {
    const plan = result.bodies.get(message.id)!;
    message.bodyHash = hashOf(message, plan.body);
    sizeOf(message, plan.body, plan.attachment);
    if (result.expired.has(message.id)) {
      message.storageKey = newStorageKey();
      message.bodyKey = newMessageKey().encoded;
      continue;
    }
    const created = message.createdAt.getTime();
    if (created <= now - retentionMs && !unique.has(message.id)) {
      // The retention sweep shredded the key; the object waits for the bucket's lifecycle rule.
      const purgedAt = Math.min(created + retentionMs + random.int(5, 60) * MINUTE, now);
      message.storageKey = newStorageKey();
      message.bodyKey = null;
      message.bodyPurgedAt = new Date(purgedAt);
      bodyEvents.push({
        id: newId("event"),
        organizationId: orgId,
        messageId: message.id,
        kind: "body_shredded",
        status: null,
        reason: null,
        bounceType: null,
        providerId: null,
        providerEventId: null,
        detail: { retentionDays },
        occurredAt: new Date(purgedAt),
        createdAt: new Date(purgedAt),
      });
      const day = Math.floor(purgedAt / DAY);
      shreddedByDay.set(day, (shreddedByDay.get(day) ?? 0) + 1);
      continue;
    }
    if (unique.has(message.id)) {
      const { key, encoded } = newMessageKey();
      message.storageKey = newStorageKey();
      message.bodyKey = encoded;
      const personal = result.landmarks.has(message.id) ? plan.body : personalize(plan);
      message.bodyHash = hashOf(message, personal);
      sizeOf(message, personal, plan.attachment);
      writes.push({ storageKey: message.storageKey, key, body: personal, attachment: plan.attachment });
      continue;
    }
    let shared = sharedKeys.get(plan.shared);
    if (!shared) {
      const { key, encoded } = newMessageKey();
      shared = { storageKey: newStorageKey(), key, encoded, body: plan.body, attachment: plan.attachment };
      sharedKeys.set(plan.shared, shared);
      writes.push(shared);
    }
    message.storageKey = shared.storageKey;
    message.bodyKey = shared.encoded;
  }

  const inbound = [
    ...planInbound(history, random, orgId, { domain: s("scope"), host: "inbound.scope.example", days: 30, perDay: 4, retentionDays: 30, outbound: result.messages.filter((m) => m.domainId === scope && !m.testMode) }),
    ...planInbound(history, random, orgId, { domain: s("cedarvine"), host: "inbound.cedarvine.dev", days: 7, perDay: 3, retentionDays: 7, outbound: result.messages.filter((m) => m.domainId === cedarvineDev) }),
  ];

  const webhooks = planWebhooks(
    history,
    random,
    orgId,
    [
      { url: "https://hooks.scope.example/pouch", events: ["email.delivered", "email.bounced", "email.complained"], description: "Delivery status for the app", key: k("scopeProd"), createdAgo: 110 * DAY },
      {
        url: "https://cedarvine.dev/api/pouch-events",
        events: ["email.bounced", "email.complained"],
        description: "Old storefront hook",
        key: k("siteKey"),
        createdAgo: 150 * DAY,
        ...(calm ? {} : { broken: { status: 404, error: "404 Not Found", disabledAgo: 5 * DAY } }),
      },
      { url: "https://fieldnotes.app/hooks/lists", events: ["email.unsubscribed", "list.subscribed"], description: "Sync list changes to the CRM", key: k("newsletter"), createdAgo: 90 * DAY },
      { url: "https://support.scope.example/inbound", events: ["inbound.received"], description: "Support inbox", domain: s("scope"), createdAgo: 100 * DAY },
      { url: "https://cedarvine.dev/api/inbound", events: ["inbound.received"], description: "Order replies", domain: s("cedarvine"), createdAgo: 60 * DAY },
    ],
    result.messages,
    result.events,
    inbound,
  );

  // Its own seed, so the rest of the fill stays as it was.
  const addressPlan = planAddresses(history, mulberry32(SEED + 1), orgId, { domain: s("scope"), host: "inbound.scope.example", key: k("scopeProd") });
  Object.assign(landmarks, addressPlan.landmarks);

  const unsubscribes = listPlans
    .slice(0, 2)
    .flatMap((plan) => plan.members.filter((m) => m.status === "unsubscribed"))
    .slice(0, 6)
    .map((m) => ({ id: newId("domainUnsubscribe"), organizationId: orgId, domainId: fieldnotes, address: m.address, createdAt: m.unsubscribedAt! }));

  const log = new ActivityLog(random, orgId);
  const worker = (label: string): ActivityActor => ({ type: "worker", id: null, label });
  const domainDates: [string, string, number, number | null][] = [
    [scope, "scope.example", 240 * DAY, 240 * DAY - 20 * MINUTE],
    [cedarvineDev, "cedarvine.dev", (retentionDays + 60) * DAY, (retentionDays + 60) * DAY - 35 * MINUTE],
    [fieldnotes, "fieldnotes.app", 195 * DAY, 195 * DAY - 12 * MINUTE],
    [harborline, "harborline.co", 52 * DAY, 51 * DAY],
    [northgate, "northgate.dev", 3 * HOUR, 2 * HOUR],
    [moc, "market.example", 15 * MINUTE, null],
    [cedarvine, "cedarvine.com", 9 * DAY, null],
  ];
  for (const [id, name, added, verified] of domainDates) {
    log.add(now - added, "domain.added", owner, { id, label: name });
    if (verified !== null) log.add(now - verified, "domain.verified", worker("Verification"), { id, label: name });
  }
  for (const [name, spec] of Object.entries(keySpecs)) {
    log.add(now - spec.createdAgo, "key.created", name === "harborlineKey" || name === "ciKey" ? member : owner, { id: k(name).id, label: spec.name });
    if (spec.revokedAgo) log.add(now - spec.revokedAgo, "key.revoked", owner, { id: k(name).id, label: spec.name });
  }
  log.add(now - 150 * DAY, "domain.layout.changed", owner, { id: scope, label: "scope.example" });
  log.add(now - 180 * DAY, "domain.layout.changed", member, { id: fieldnotes, label: "fieldnotes.app" });
  log.add(now - 175 * DAY, "domain.bulk.enabled", owner, { id: fieldnotes, label: "fieldnotes.app" });
  log.add(now - 132 * DAY, "domain.bulk.enabled", owner, { id: scope, label: "scope.example" });
  log.add(now - 100 * DAY, "domain.inbound.enabled", owner, { id: scope, label: "scope.example" });
  log.add(now - 60 * DAY, "domain.inbound.enabled", member, { id: cedarvineDev, label: "cedarvine.dev" });
  for (const endpoint of webhooks.endpoints) {
    log.add(endpoint.createdAt.getTime(), "webhook.endpoint.created", owner, { id: endpoint.id, label: endpoint.url }, { events: endpoint.events });
    if (endpoint.disabledAt) {
      log.add(endpoint.disabledAt.getTime(), "system.endpoint.auto_disabled", worker("Webhook delivery"), { id: endpoint.id, label: endpoint.url }, { consecutiveFailures: 25 });
    }
  }
  for (const plan of listPlans) {
    log.add(plan.list.createdAt.getTime(), "list.created", owner, { id: plan.list.id, label: plan.list.name });
    const imported = plan.members.filter((m) => m.source === "import").length;
    if (imported > 0) log.add(plan.list.createdAt.getTime() + 5 * MINUTE, "list.members.imported", owner, { id: plan.list.id, label: plan.list.name }, { count: imported });
  }
  log.add(importedAt, "suppression.imported", owner, {}, { count: 80, source: "postmark" });
  log.add(now - 37 * DAY, "suppression.added", owner, { id: doNotMail, label: "do-not-mail@northgate.io" }, { reason: "manual", detail: "Asked to be removed by phone." });
  result.manual.forEach((entry, i) => {
    log.add(entry.at, "suppression.added", i % 3 === 2 ? member : owner, { id: entry.id, label: entry.address }, { reason: "manual", detail: entry.detail });
  });
  log.add(now - 47 * DAY, "suppression.removed", owner, { id: newId("suppression"), label: "grace.hall@tidewater.edu" }, { reason: "hard_bounce" });
  log.add(now - 16 * DAY, "suppression.removed", member, { id: newId("suppression"), label: "orders@saltbox.design" }, { reason: "complaint" });
  log.add(spikeAt + 70 * MINUTE, "domain.reputation.changed", worker("Reputation"), { id: scope, label: "scope.example" }, { from: "healthy", to: "watch", findings: ["bounce_rate"] });
  log.add(spikeAt + 7 * DAY + 2 * HOUR, "domain.reputation.changed", worker("Reputation"), { id: scope, label: "scope.example" }, { from: "watch", to: "healthy", findings: [] });
  if (bad) log.add(stalledAt, "domain.stalled", worker("Stall guard"), { id: harborline, label: "harborline.co" }, { reason: stall.reason, ...stall.detail });
  if (bad) log.add(stalledAt + 40 * SECOND, "domain.reputation.changed", worker("Reputation"), { id: harborline, label: "harborline.co" }, { from: "healthy", to: "paused", findings: ["paused"] });
  for (const [day, count] of shreddedByDay) log.add(day * DAY + 3 * HOUR + random.int(0, 50) * MINUTE, "system.retention.swept", worker("Retention sweep"), {}, { count });
  const abandonedByDay = new Map<number, number>();
  for (const message of result.messages) {
    if (!message.abandonedAt) continue;
    const day = Math.floor(message.abandonedAt.getTime() / DAY);
    abandonedByDay.set(day, (abandonedByDay.get(day) ?? 0) + 1);
  }
  for (const [day, count] of abandonedByDay) log.add(Math.min(day * DAY + 23 * HOUR, now - MINUTE), "system.abandon.swept", worker("Abandon sweep"), {}, { count });
  if (retentionDays !== 45) log.add(now - 170 * DAY, "settings.retention.changed", owner, {}, { from: 45, to: retentionDays });
  log.add(now - 40 * DAY, "member.invited", owner, { label: DEV_ACCOUNTS.member2.email });
  log.add(now - 39 * DAY, "member.joined", { type: "user", id: null, label: DEV_ACCOUNTS.member2.name });
  for (let day = 179; day >= 0; day -= 1) {
    const weekday = new Date(history.dayStart(day) + 12 * HOUR).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (random.chance(0.45)) log.add(history.timeOfDay(history.dayStart(day)), "session.signed_in", owner);
    if (random.chance(0.25)) log.add(history.timeOfDay(history.dayStart(day)), "session.signed_in", member);
  }
  log.add(now - 12 * DAY, "session.sign_in.failed", { type: "user", id: null, label: DEV_ACCOUNTS.owner.email }, {}, { reason: "Wrong password." });
  const activityRows = log.rows.filter((row) => (row.createdAt as Date).getTime() <= now);

  const rejections = [...result.rejections].map(([key, count]) => {
    const [domainId, hour] = key.split("|");
    return { organizationId: orgId, domainId: domainId!, hour: new Date(Number(hour)), count };
  });

  // Writes, in dependency order.
  const events = [...result.events, ...bodyEvents, ...webhooks.events];
  for (const plan of listPlans) {
    await db.insert(lists).values(plan.list);
    await chunked(plan.members, 1000, (chunk) => db.insert(listMemberships).values(chunk));
    if (plan.batches.length > 0) await db.insert(batches).values(plan.batches);
  }
  await chunked(result.messages, 500, (chunk) => db.insert(messages).values(chunk));
  await chunked(events, 1000, (chunk) => db.insert(messageEvents).values(chunk));
  await chunked(result.suppressions, 1000, (chunk) => db.insert(suppressions).values(chunk));
  await chunked(result.history, 1000, (chunk) => db.insert(recipientHistory).values(chunk));
  if (rejections.length > 0) await db.insert(suppressedRejections).values(rejections);
  await chunked(inbound, 500, (chunk) => db.insert(inboundMessages).values(chunk));
  await db.insert(addresses).values(addressPlan.addresses);
  if (addressPlan.targets.length > 0) await db.insert(addressForwardTargets).values(addressPlan.targets);
  if (addressPlan.inbound.length > 0) await db.insert(inboundMessages).values(addressPlan.inbound);
  await db.insert(webhookEndpoints).values(webhooks.endpoints);
  await chunked(webhooks.deliveries, 500, (chunk) => db.insert(webhookDeliveries).values(chunk));
  await chunked(webhooks.attempts, 1000, (chunk) => db.insert(webhookAttempts).values(chunk));
  await sealLegacyInbound({ organizationId: orgId });
  if (unsubscribes.length > 0) await db.insert(domainUnsubscribes).values(unsubscribes);
  await chunked(activityRows, 1000, (chunk) => db.insert(activity).values(chunk));

  if (bad) {
    await db
      .update(domains)
      .set({ stalledAt: new Date(stalledAt), stallReason: stall.reason, stallDetail: stall.detail, stallCheckedAt: new Date(now - 2 * MINUTE) })
      .where(eq(domains.id, harborline));
    // SES is throttling right now: due sends wait it out.
    await db
      .update(providers)
      .set({ backoffUntil: new Date(now + 12 * MINUTE), backingOffSince: new Date(now - 25 * MINUTE) })
      .where(eq(providers.id, ses));
    await db
      .insert(reputationStates)
    .values({ organizationId: orgId, subjectType: "domain", subjectId: harborline, standing: "paused", changedAt: new Date(stalledAt + 40 * SECOND), alertedStanding: "paused", alertedAt: new Date(stalledAt + 40 * SECOND) })
    .onConflictDoUpdate({
      target: [reputationStates.subjectType, reputationStates.subjectId],
      set: { organizationId: orgId, standing: "paused", changedAt: new Date(stalledAt + 40 * SECOND), alertedStanding: "paused", alertedAt: new Date(stalledAt + 40 * SECOND), updatedAt: new Date() },
    });
  }

  const lastUsed = new Map<string, number>();
  for (const message of result.messages) {
    if (!message.apiKeyId) continue;
    lastUsed.set(message.apiKeyId, Math.max(lastUsed.get(message.apiKeyId) ?? 0, message.createdAt.getTime()));
  }
  for (const [id, at] of lastUsed) await db.update(apiKeys).set({ lastUsedAt: new Date(at) }).where(eq(apiKeys.id, id));

  await parallel(writes, 16, async (write) => {
    const attachments = write.attachment
      ? [{ filename: write.attachment.filename, contentType: write.attachment.contentType, content: "A".repeat(Math.round((write.attachment.kilobytes * 1024 * 4) / 3)) }]
      : [];
    await writeBody(write.key, write.storageKey, { html: write.body.html, text: write.body.text, textGenerated: false, attachments });
  });

  const search = searchProvider();
  if (search.mode !== "postgres") {
    const counts = await reindex(search, { organizationId: orgId, fresh: true });
    console.log(`search: indexed ${counts.messages} messages and ${counts.suppressions} suppressions`);
  }

  // Rows picked from the generated history, for the screens that need one of a kind.
  const newest = (predicate: (m: MessageRow) => boolean) =>
    result.messages.filter(predicate).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]?.id;
  const bodyOf = (m: MessageRow) => result.bodies.get(m.id)?.body;
  const picks: Record<string, string | undefined> = {
    textOnly: newest((m) => m.status === "delivered" && unique.has(m.id) && bodyOf(m)?.html === null),
    htmlOnly: newest((m) => m.status === "delivered" && unique.has(m.id) && bodyOf(m)?.text === null),
    held: newest((m) => m.domainId === harborline && m.status === "queued"),
    abandoned: newest((m) => m.abandonedAt !== null),
    purged: newest((m) => m.bodyPurgedAt !== null),
    batch: listPlans[0]!.batches[listPlans[0]!.batches.length - 1]?.id,
    list: listPlans[0]!.list.id,
    inbound: [...inbound].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0]?.id,
    reply: inbound.filter((row) => row.outboundMessageId).sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())[0]?.id,
  };
  for (const [name, id] of Object.entries(picks)) if (id) landmarks[name] = id;

  landmarks.scenario = scenario;
  // The screenshot pass addresses rows by name rather than by an id copied into a script.
  await writeFile(".dev-data.json", `${JSON.stringify(landmarks, null, 2)}\n`);

  const byStatus = new Map<string, number>();
  for (const message of result.messages) byStatus.set(message.status, (byStatus.get(message.status) ?? 0) + 1);
  console.log(
    [
      `${scenario}: ${result.messages.length} messages (${[...byStatus].map(([status, count]) => `${count} ${status}`).join(", ")})`,
      `${events.length} events, ${result.suppressions.length} suppressions, ${result.history.length} recipients`,
      `${listPlans.length} lists, ${listPlans.reduce((n, p) => n + p.members.length, 0)} members, ${listPlans.reduce((n, p) => n + p.batches.length, 0)} batches`,
      `${inbound.length} inbound, ${webhooks.endpoints.length} endpoints, ${webhooks.deliveries.length} webhook deliveries, ${activityRows.length} activity rows`,
      `${writes.length} bodies written, ${Object.keys(keySpecs).length} keys, ${DEV_DOMAINS.length - 1} domains`,
    ].join("\n"),
  );

  const reputation = await readOrganizationReputation(orgId, new Date()).catch(() => null);
  if (reputation) {
    const standings = [...reputation.domains.values()].filter((d) => ourDomainIds.includes(d.id)).sort((a, b) => a.name.localeCompare(b.name)).map((d) => `${d.name} ${d.standing}`);
    console.log(`standing: ${reputation.standing}; ${standings.join(", ")}`);
  }
  console.log(`filled in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/** The first Tuesday to Thursday at or before `day` days ago, so an incident lands on a busy day. */
function midweek(history: History, day: number): number {
  for (let candidate = day; ; candidate += 1) {
    const weekday = new Date(history.dayStart(candidate) + 12 * HOUR).getUTCDay();
    if (weekday >= 2 && weekday <= 4) return candidate;
  }
}

/** The recent rows' bodies greet the recipient by name. */
function personalize(plan: { name: string; body: Body }): Body {
  const swap = (value: string | null) => (value === null ? null : value.replaceAll("Hi there", `Hi ${plan.name}`).replaceAll("Good news, there", `Good news, ${plan.name}`));
  return { html: swap(plan.body.html), text: swap(plan.body.text) };
}

function stallDetail(rows: MessageRow[], domainId: string, at: number): { reason: StallReason; detail: StallDetail } {
  const window = (since: number, until: number) => {
    let bounced = 0;
    let denominator = 0;
    for (const m of rows) {
      const created = m.createdAt.getTime();
      if (m.domainId !== domainId || m.testMode || created < since || created >= until) continue;
      if (m.status === "bounced") bounced += 1;
      if (m.status === "delivered" || m.status === "bounced" || m.status === "complained" || m.status === "failed") denominator += 1;
    }
    return { bounced, denominator };
  };
  const current = window(at - 7 * DAY, at);
  const previous = window(at - 14 * DAY, at - 7 * DAY);
  const currentRate = rate(current.bounced, current.denominator);
  return {
    reason: currentRate === null ? "bounce_count" : "bounce_rate",
    detail: {
      metric: "bounce",
      count: current.bounced,
      denominator: current.denominator,
      rate: currentRate,
      previousRate: rate(previous.bounced, previous.denominator, RATE_FLOOR),
      threshold: DEFAULT_STALL_LINES.bounce.stall,
    },
  };
}

async function userActor(email: string): Promise<ActivityActor> {
  const [row] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email)).limit(1);
  return { type: "user", id: row?.id ?? null, label: row?.name ?? email };
}

/** An https URL, since the layout form refuses anything else. The files are the marks in scripts/dev-data. */
function devLogo(file: string): string {
  return `https://static.pouch.email/dev/${file}`;
}

const DEV_LOGOS: Record<string, string> = { "scope.example": "scope-mark.png", "fieldnotes.app": "fieldnotes-mark.png" };

/** Rewrites the seeded layouts' logos in place, for a database seeded before the marks were bundled. */
async function refreshLogos(orgId: string): Promise<void> {
  const rows = await db
    .select({ id: domains.id, name: domains.name, layout: domains.layout })
    .from(domains)
    .where(and(eq(domains.organizationId, orgId), inArray(domains.name, Object.keys(DEV_LOGOS))));
  for (const row of rows) {
    if (!row.layout) continue;
    await db
      .update(domains)
      .set({ layout: { ...row.layout, logoUrl: devLogo(DEV_LOGOS[row.name]!) } })
      .where(eq(domains.id, row.id));
    console.log(`${row.name}: logo updated`);
  }
}

async function main(): Promise<void> {
  const orgId = await organizationId();
  await seedDevUsers(orgId);
  const args = process.argv.slice(2).filter((arg) => arg !== "fill");
  const command = args[0];

  if (command === "clear") await clearMessages(orgId);
  else if (command === "reset") await reset(orgId);
  else if (command === "logos") await refreshLogos(orgId);
  else {
    const scenario = (command ?? "bad") as Scenario;
    if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown scenario "${command}". Use ${SCENARIOS.join(", ")}.`);
    await fill(orgId, scenario);
  }

  await closeDb();
  // The standing read goes through Redis; an open client keeps the process alive.
  await closeRedis();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  await closeRedis();
  process.exit(1);
});

