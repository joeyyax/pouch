import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, providers } from "@/lib/db/schema";
import { ADAPTER_KEYS, credentialsSchemaOf } from "@/lib/providers/adapters";
import { readHeartbeats } from "@/lib/health";
import { readProvider } from "@/lib/providers";
import { workerActor } from "@/lib/activity/record";
import { adapterLabel } from "@/lib/dashboard/views/domains";
import type { CredentialFieldSpec, SendingProviderView, ServiceHealth } from "@/lib/dashboard/views/service";


/** The fields an adapter's credentials take, and what to ask for each one — read off its own zod schema. */
export function credentialFieldSpecsOf(adapter: string): CredentialFieldSpec[] {
  if (!ADAPTER_KEYS.includes(adapter)) return [];
  return Object.entries(credentialsSchemaOf(adapter).shape).map(([name, field]) => ({
    name,
    description: field.description ?? "",
    required: !field.isOptional(),
  }));
}

/** The organization's assigned provider and whether it can send, or null when none is assigned. */
export async function readSendingProvider(organizationId: string): Promise<SendingProviderView | null> {
  const [row] = await db
    .select({ id: providers.id, sharedProviderId: providers.sharedProviderId })
    .from(organizations)
    .innerJoin(providers, eq(providers.id, organizations.providerId))
    .where(eq(organizations.id, organizationId))
    .limit(1);
  if (!row) return null;

  const provider = await readProvider({ organizationId, domainIds: [], actor: workerActor() }, row.id);
  const backoffUntil = provider.backoff_until ? new Date(provider.backoff_until) : null;
  return {
    name: provider.name,
    adapterLabel: adapterLabel(provider.adapter),
    status: provider.status,
    backoffUntil: backoffUntil && backoffUntil.getTime() > Date.now() ? backoffUntil : null,
    adminProviderId: row.sharedProviderId ?? row.id,
  };
}

/**
 * Every worker currently reporting in, plus the honest floor for "healthy": at least one alive,
 * since the queue still drains with fewer than expected. "unknown" is its own answer: with no
 * Redis the dashboard can't tell a stopped fleet from one it simply can't hear.
 */
export async function readServiceHealth(): Promise<ServiceHealth> {
  if (!process.env.REDIS_URL) return { worker: "unknown", workers: [] };

  const beats = await readHeartbeats();
  const workers = beats.map((beat) => ({ id: beat.workerId, lastBeatAt: new Date(beat.at) }));
  return { worker: workers.length > 0 ? "healthy" : "silent", workers };
}
