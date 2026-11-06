import { and, eq } from "drizzle-orm";
import { ApiError } from "@/lib/api/errors";
import { decrypt, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";
import { dnsProviderAccounts } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { buildDnsProvider, dnsCredentialsSchemaOf } from "./index";
import type { AdapterHealth, DnsProvider, DnsProviderSettings } from "./types";

export type DnsProviderAccountRow = typeof dnsProviderAccounts.$inferSelect;

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  const candidates = [err, (err as { cause?: unknown }).cause];
  return candidates.some((candidate) => (candidate as { code?: string } | undefined)?.code === UNIQUE_VIOLATION);
}

function nameConflictError(name: string): ApiError {
  return new ApiError("provider_exists", `A DNS provider account named "${name}" already exists.`, { field: "name" });
}

export function encryptCredentials(credentials: Record<string, string>): string {
  return encrypt(JSON.stringify(credentials));
}

export function decryptCredentials(account: DnsProviderAccountRow): Record<string, string> {
  return JSON.parse(decrypt(account.credentials)) as Record<string, string>;
}

/** Builds the DNS provider for an account, decrypting its credentials. */
export function dnsProviderFor(account: DnsProviderAccountRow): DnsProvider {
  return buildDnsProvider(account.module, decryptCredentials(account), account.settings, account.id);
}

/** Validates a credentials object against its module's schema. Unknown fields are dropped. Rejects a global API key at parse time. */
export function validateDnsCredentials(module: string, credentials: Record<string, string>): Record<string, string> {
  const result = dnsCredentialsSchemaOf(module).safeParse(credentials);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue ? `credentials.${issue.path.join(".")}` : "credentials";
    throw new ApiError("validation_failed", `Field "${field}" isn't valid: ${issue?.message ?? "credentials aren't valid"}.`, {
      field: "credentials",
    });
  }
  return result.data as Record<string, string>;
}

/**
 * Calls the module's cheap health probe with the credentials about to be stored, and refuses
 * them outright when it answers `false`. Same rule as `docs/decisions.md`'s "Credentials are
 * verified before they're stored" for providers.
 */
async function verifyOrThrow(
  module: string,
  credentials: Record<string, string>,
  settings: DnsProviderSettings,
  accountId: string,
): Promise<AdapterHealth["ok"]> {
  const provider = buildDnsProvider(module, credentials, settings, accountId);
  const health = await provider.healthCheck();
  if (health.ok === false) {
    throw new ApiError("credentials_rejected", health.detail ?? "The provider refused these credentials.");
  }
  return health.ok;
}

export interface CreateDnsProviderAccountRequest {
  module: string;
  name: string;
  credentials: Record<string, string>;
  settings?: DnsProviderSettings;
}

/**
 * Creates a DNS provider account. Credentials are checked live against the provider before
 * anything is stored — a create can't leave the organization holding a token that fails on the
 * first read.
 */
export async function createDnsProviderAccount(
  organizationId: string,
  request: CreateDnsProviderAccountRequest,
): Promise<DnsProviderAccountRow & { credentials_verified: AdapterHealth["ok"] }> {
  const credentials = validateDnsCredentials(request.module, request.credentials);
  const settings = request.settings ?? {};

  const [existing] = await db
    .select({ id: dnsProviderAccounts.id })
    .from(dnsProviderAccounts)
    .where(and(eq(dnsProviderAccounts.organizationId, organizationId), eq(dnsProviderAccounts.name, request.name)))
    .limit(1);
  if (existing) throw nameConflictError(request.name);

  const id = newId("dnsProviderAccount");
  const verified = await verifyOrThrow(request.module, credentials, settings, id);

  let row: DnsProviderAccountRow | undefined;
  try {
    [row] = await db
      .insert(dnsProviderAccounts)
      .values({
        id,
        organizationId,
        module: request.module,
        name: request.name,
        credentials: encryptCredentials(credentials),
        settings,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw nameConflictError(request.name);
    throw err;
  }
  if (!row) throw new ApiError("provider_unavailable", "The DNS provider account couldn't be created.");

  return { ...row, credentials_verified: verified };
}
