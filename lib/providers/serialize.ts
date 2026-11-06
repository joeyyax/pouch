import type { ProviderRow } from "./index";

export const PROVIDER_STATUSES = ["ready", "setting_up", "paused", "unavailable"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

/** Fields any provider response carries. Never settings, never credentials. */
export interface SerializedProvider {
  id: string;
  adapter: string;
  name: string;
  backoff_until: string | null;
  created_at: string;
  updated_at: string;
}

/** What an organization key reads. */
export interface OrganizationProvider extends SerializedProvider {
  /** The organization's default: a new domain binds to it. */
  assigned: boolean;
  status: ProviderStatus;
}

/**
 * Settings carry provider ARNs, which name the operator's AWS account, so they stay out too.
 * `decryptCredentials` is for the provider layer, never a response.
 */
export function serializeProvider(provider: ProviderRow): SerializedProvider {
  return {
    id: provider.id,
    adapter: provider.adapter,
    name: provider.name,
    backoff_until: provider.backoffUntil?.toISOString() ?? null,
    created_at: provider.createdAt.toISOString(),
    updated_at: provider.updatedAt.toISOString(),
  };
}

/**
 * Present on a create or a credential-changing update, and only then — the one thing it answers
 * is whether *this write's* credentials were actually checked against the provider. `true` means
 * the check ran and passed (a failed check throws instead of reaching a response). `null` means
 * the adapter has no way to check itself, so the write went in unverified, not confirmed working —
 * read it as unverified, never as a quiet pass.
 */
export interface ProviderWriteFields {
  credentials_verified: boolean | null;
}
