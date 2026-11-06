import "@/lib/env";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/lib/db";
import { apiKeys, domains, memberships, organizations, users } from "@/lib/db/schema";
import { bootstrapProvider, type BootstrapProvider } from "@/scripts/bootstrap-provider";
import { workerActor } from "@/lib/activity/record";
import { parseCredentials, parseSettings } from "@/lib/providers/credentials";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { createAccountWithPassword } from "@/lib/auth/provisioning";
import { ROLES } from "@/lib/auth/permissions";
import { configureEvents, createDomain } from "@/lib/domains";
import { newId } from "@/lib/ids";
import { ADAPTER_KEYS } from "@/lib/providers/adapters";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} isn't set.`);
  return value;
}

async function seedOrganization(): Promise<string> {
  const slug = process.env.SEED_ORGANIZATION_SLUG ?? "default";
  const [existing] = await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1);
  if (existing) return existing.id;

  const id = newId("organization");
  await db.insert(organizations).values({ id, name: process.env.SEED_ORGANIZATION_NAME ?? "Default", slug });
  console.log(`organization ${id}`);
  return id;
}

/**
 * The seeded admin gets a membership on the seeded organization *and* the operator flag —
 * two independent facts about the same person, not one derived from the other. Set
 * explicitly here rather than relying on `createMembershipForNewUser`'s first-user bootstrap:
 * this is the one path Pouch's admin is known to come through, and it shouldn't depend on
 * counting rows to get that right.
 */
async function seedAdmin(organizationId: string): Promise<void> {
  const email = required("ADMIN_EMAIL");
  const password = required("ADMIN_PASSWORD");

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    await ensureOwnerMembership(existing.id, organizationId);
    console.log(`admin ${existing.id} already exists`);
    return;
  }

  // Public sign-up is disabled, so the admin is created through Better Auth's internal
  // adapter directly rather than the /sign-up/email endpoint.
  const created = await createAccountWithPassword({
    email,
    name: process.env.ADMIN_NAME || email.split("@")[0] || "Admin",
    organizationId,
    password,
    emailVerified: true,
    admin: true,
  });
  await ensureOwnerMembership(created.id, organizationId);
  console.log(`admin ${created.id}`);
}

/** Idempotent: safe to run against a database where the membership already exists. */
async function ensureOwnerMembership(userId: string, organizationId: string): Promise<void> {
  await db.update(users).set({ admin: true }).where(eq(users.id, userId));
  const [existing] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, organizationId)))
    .limit(1);
  if (existing) return;
  await db.insert(memberships).values({ id: newId("membership"), userId, organizationId, role: ROLES.OWNER });
}

async function seedProvider(organizationId: string): Promise<BootstrapProvider> {
  const providerAdapter = process.env.SEED_PROVIDER_ADAPTER ?? "ses";
  if (!ADAPTER_KEYS.includes(providerAdapter)) {
    throw new Error(`SEED_PROVIDER_ADAPTER "${providerAdapter}" isn't a known adapter.`);
  }
  const result = await bootstrapProvider({
    organizationId,
    adapter: providerAdapter,
    name: process.env.SEED_PROVIDER_NAME ?? "primary",
    credentials: parseCredentials(providerAdapter, required("SEED_PROVIDER_CREDENTIALS")),
    settings: parseSettings(providerAdapter, process.env.SEED_PROVIDER_SETTINGS ?? ""),
    concurrency: Number(process.env.SEED_PROVIDER_CONCURRENCY ?? "16"),
  });
  console.log(`provider ${result.provider.id} (${providerAdapter}${result.parent ? `, tenant of ${result.parent.id}` : ""})`);
  return result;
}

/**
 * Builds the provider-side event plumbing: the shared provider's status rule, or an ordinary
 * provider's configuration set. A tenant's is built with its first domain.
 */
async function seedEvents({ provider, parent }: BootstrapProvider, domain: string): Promise<void> {
  const configured = await configureEvents(parent ?? provider, parent ? "" : domain);
  console.log(
    configured
      ? "provider events configured"
      : "provider events built; the subscription confirms once the provider calls back at APP_URL. If events don't arrive, re-run this or call POST /v1/domains/:id/verify.",
  );
}

async function seedDomain(organizationId: string, { provider, parent }: BootstrapProvider, name: string): Promise<string> {
  const [existing] = await db
    .select()
    .from(domains)
    .where(and(eq(domains.organizationId, organizationId), eq(domains.name, name)))
    .limit(1);
  if (existing) return existing.id;

  if (parent) {
    // A tenant exists at the provider only once its first domain is created there.
    const created = await createDomain({ organizationId, domainIds: [], actor: workerActor() }, { name, provider_id: provider.id });
    console.log(`domain ${created.id} (${name}) pending. Publish these records:`);
    for (const record of created.dns_records) console.log(`  ${record.type} ${record.name} ${record.value}`);
    return created.id;
  }

  // Pending, not verified: only a verified domain sends, and the seed has asked no provider
  // anything. The worker's verify loop picks up pending domains and flips this one on its
  // first pass if the DNS is genuinely in place.
  const id = newId("domain");
  await db.insert(domains).values({
    id,
    organizationId,
    providerId: provider.id,
    name,
    status: "pending",
  });
  console.log(`domain ${id} (${name}) pending — the verify loop confirms it`);
  return id;
}

/**
 * Unscoped (`domainIds: []`): the bootstrap key is the org's general-purpose key, not one
 * pinned to whichever domain happened to be seeded alongside it. A key scoped to a single
 * domain can't add another (`lib/domains/index.ts:81` refuses outright), and only sees that
 * one in listings (`lib/domains/index.ts:235`) — #185.
 */
async function seedApiKey(organizationId: string): Promise<void> {
  const name = process.env.SEED_KEY_NAME ?? "bootstrap";
  const existing = await db.select().from(apiKeys).where(eq(apiKeys.organizationId, organizationId)).limit(1);
  if (existing.length > 0) {
    console.log("api key already exists, not creating another");
    return;
  }

  const mode = process.env.SEED_KEY_MODE ?? "live";
  if (mode !== "live" && mode !== "test") throw new Error(`SEED_KEY_MODE must be "live" or "test", got "${mode}".`);
  const minted = await createApiKey({ organizationId, name, mode, domainIds: [] });

  console.log(`\napi key ${minted.key.id}`);
  console.log(`  ${minted.secret}`);
  console.log("  Shown once. Store it now.\n");
}

async function main(): Promise<void> {
  const organizationId = await seedOrganization();
  await seedAdmin(organizationId);
  const provider = await seedProvider(organizationId);
  const domain = required("SEED_DOMAIN");
  await seedEvents(provider, domain);
  await seedDomain(organizationId, provider, domain);
  await seedApiKey(organizationId);
  await closeDb();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
