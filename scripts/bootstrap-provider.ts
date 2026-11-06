/** First-run provider setup for `pnpm seed`. */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, providers } from "@/lib/db/schema";
import { workerActor } from "@/lib/activity/record";
import { newId } from "@/lib/ids";
import { capabilitiesOf } from "@/lib/providers/adapters";
import { decryptCredentials, encryptCredentials, type ProviderRow } from "@/lib/providers";
import { CredentialsUnreadableError } from "@/lib/providers/unreadable";
import { onboardOrganization } from "@/lib/providers/shared";

export interface BootstrapProviderInput {
  organizationId: string;
  adapter: string;
  name: string;
  credentials: Record<string, string>;
  settings: Record<string, string>;
  concurrency: number;
}

export interface BootstrapProvider {
  /** The row the organization's domains bind to. */
  provider: ProviderRow;
  /** The shared provider behind an assignment row, when the adapter can be shared. */
  parent: ProviderRow | null;
}

function sameCredentials(row: ProviderRow, credentials: Record<string, string>): boolean {
  const stored = decryptCredentials(row);
  const keys = new Set([...Object.keys(stored), ...Object.keys(credentials)]);
  return [...keys].every((key) => stored[key] === credentials[key]);
}

/** A free name among shared providers, starting from `base`. */
async function freeSharedName(base: string): Promise<string> {
  const rows = await db.select({ name: providers.name }).from(providers).where(eq(providers.shared, true));
  const taken = new Set(rows.map((row) => row.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
}

/** The shared provider holding these credentials, created when none does. */
async function sharedParent(input: BootstrapProviderInput): Promise<ProviderRow> {
  const candidates = await db
    .select()
    .from(providers)
    .where(and(eq(providers.shared, true), eq(providers.adapter, input.adapter)));
  const match = candidates.find((row) => sameCredentials(row, input.credentials));
  if (match) return match;

  const [parent] = await db
    .insert(providers)
    .values({
      id: newId("provider"),
      adapter: input.adapter,
      name: await freeSharedName(`${input.name} (shared)`),
      credentials: encryptCredentials(input.credentials),
      settings: { sharing: "operator" },
      concurrency: input.concurrency,
      shared: true,
    })
    .returning();
  if (!parent) throw new Error("The shared provider couldn't be persisted.");
  return parent;
}

/**
 * Gives the organization its provider: the one it already has, an assignment row on a shared provider for
 * a shareable adapter, or its own row otherwise. Makes no provider call.
 */
export async function bootstrapProvider(input: BootstrapProviderInput): Promise<BootstrapProvider> {
  const [org] = await db
    .select({ providerId: organizations.providerId })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1);
  if (!org) throw new Error(`No organization with id ${input.organizationId}.`);

  // The default, else one named like this, else the oldest: a second assignment is never created here.
  const [existing] = await db
    .select()
    .from(providers)
    .where(and(eq(providers.organizationId, input.organizationId), eq(providers.shared, false)))
    .orderBy(
      sql`${providers.id} = ${org.providerId ?? ""} desc`,
      sql`${providers.name} = ${input.name} desc`,
      asc(providers.createdAt),
    )
    .limit(1);
  if (existing) {
    await setDefaultIfUnset(input.organizationId, existing.id);
    warnIfUnreadable(existing);
    const parent = existing.sharedProviderId ? await rowById(existing.sharedProviderId) : null;
    return { provider: existing, parent };
  }

  if (capabilitiesOf(input.adapter).sharing) {
    const parent = await sharedParent(input);
    const { provider } = await onboardOrganization(parent.id, input.organizationId, workerActor(), { name: input.name });
    return { provider, parent };
  }

  const [provider] = await db
    .insert(providers)
    .values({
      id: newId("provider"),
      organizationId: input.organizationId,
      adapter: input.adapter,
      name: input.name,
      credentials: encryptCredentials(input.credentials),
      settings: input.settings,
      concurrency: input.concurrency,
    })
    .returning();
  if (!provider) throw new Error("The provider couldn't be persisted.");
  await setDefaultIfUnset(input.organizationId, provider.id);
  return { provider, parent: null };
}

/** A row written under an earlier ENCRYPTION_KEY fails every send and domain add; say so at startup. */
function warnIfUnreadable(provider: ProviderRow): void {
  try {
    decryptCredentials(provider);
  } catch (error) {
    if (!(error instanceof CredentialsUnreadableError)) throw error;
    console.warn(`${error.message} Re-enter them in Admin settings, Providers, or restore the key they were written with.`);
  }
}

async function rowById(id: string): Promise<ProviderRow | null> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
  return row ?? null;
}

async function setDefaultIfUnset(organizationId: string, providerId: string): Promise<void> {
  const [org] = await db.select({ providerId: organizations.providerId }).from(organizations).where(eq(organizations.id, organizationId)).limit(1);
  if (org && !org.providerId) {
    await db.update(organizations).set({ providerId: providerId, updatedAt: new Date() }).where(eq(organizations.id, organizationId));
  }
}
