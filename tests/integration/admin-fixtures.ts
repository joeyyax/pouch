import { db } from "@/lib/db";
import { providers, users } from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { newId } from "@/lib/ids";
import type { McpToolDefinition } from "@/lib/mcp/registry";
import { invokeTool } from "@/lib/mcp/invoke";
import { seedSystemOrganization } from "./fixtures";

export const SES_SECRET = "ses-secret-access-key-do-not-leak";
export const SES_CREDENTIALS = { accessKeyId: "AKIADONOTLEAK", secretAccessKey: SES_SECRET, region: "us-west-2" };

export interface AdminFixture {
  /** The organization holding the system from address's domain, and the admin user's own. */
  organizationId: string;
  adminUserId: string;
  secret: string;
  keyId: string;
}

/** An organization system mail sends from, an admin user and an admin key they created. */
export async function seedAdmin(): Promise<AdminFixture> {
  const { organizationId } = await seedSystemOrganization();
  const adminUserId = crypto.randomUUID();
  await db.insert(users).values({ id: adminUserId, organizationId, name: "Admin", email: `${adminUserId}@example.com`, admin: true });
  const { key, secret } = await createApiKey({
    organizationId: null,
    name: "mcp",
    mode: "live",
    domainIds: [],
    scope: "admin",
    createdBy: adminUserId,
  });
  return { organizationId, adminUserId, secret, keyId: key.id };
}

/** A shared SES account, inserted directly so nothing calls AWS. */
export async function seedSharedSes(name = "Hosted"): Promise<string> {
  const id = newId("provider");
  await db.insert(providers).values({
    id,
    adapter: "ses",
    name,
    credentials: encryptCredentials(SES_CREDENTIALS),
    settings: { sharing: "operator", topicArn: "arn:aws:sns:us-west-2:111122223333:status", subscriptionConfirmed: "true", eventRuleArn: "arn:rule" },
    providerIdentity: "111122223333",
    shared: true,
  });
  return id;
}

/** Calls a registry tool's route handler directly, the way `/mcp` does. */
export async function callRoute(tool: McpToolDefinition, secret: string, args: Record<string, unknown> = {}): Promise<Response> {
  return invokeTool(tool, `Bearer ${secret}`, args);
}
