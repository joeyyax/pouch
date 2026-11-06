/**
 * Admin keys, which belong to the service. Minted and revoked only in the dashboard — see
 * docs/decisions.md, "Admin keys die with their creator's admin role".
 */
import { ApiError } from "@/lib/api/errors";
import { createApiKey, revokeApiKey, type MintedKey } from "@/lib/api/key-lifecycle";
import type { ApiKeyRow } from "@/lib/api/keys";
import { adminActor, recordActivity } from "@/lib/activity/record";
import type { CreateAdminKeyRequest } from "@/lib/schemas/key";
import { assertNameAvailable } from "./index";

/** The admin doing it. `createApiKey` checks they're still an admin. */
export interface AdminKeyCaller {
  id: string;
  name: string;
}

export async function createAdminKey(caller: AdminKeyCaller, request: CreateAdminKeyRequest): Promise<MintedKey> {
  await assertNameAvailable(null, request.name, undefined, "admin");

  const minted = await createApiKey({
    organizationId: null,
    name: request.name,
    mode: "live",
    domainIds: [],
    scope: "admin",
    createdBy: caller.id,
  });

  await recordActivity({
    organizationId: minted.key.organizationId,
    action: "key.created",
    actor: adminActor(caller.id, caller.name),
    appliesTo: minted.key.id,
    subjectLabel: minted.key.name,
    metadata: { mode: minted.key.mode, scope: minted.key.scope },
  });

  return minted;
}

export async function revokeAdminKey(caller: AdminKeyCaller, id: string): Promise<ApiKeyRow> {
  const key = await revokeApiKey(null, id, "admin");
  if (!key) throw new ApiError("not_found", "That admin key doesn't exist.");

  await recordActivity({
    organizationId: key.organizationId,
    action: "key.revoked",
    actor: adminActor(caller.id, caller.name),
    appliesTo: key.id,
    subjectLabel: key.name,
    metadata: { scope: key.scope },
  });

  return key;
}
