import type { apiKeys } from "@/lib/db/schema";
import { sendSystemAlert } from "@/lib/mail/system";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { organizationName } from "./names";

type ApiKeyRow = typeof apiKeys.$inferSelect;

/**
 * A key is revoked once — `revokedAt` never clears — but the timestamp still keys the alert so a
 * worker or action that retries the same revocation replays the same message.
 */
function idempotencyKey(key: ApiKeyRow): string {
  const revokedAt = key.revokedAt?.toISOString() ?? "unknown";
  return `key-revoked:${key.id}:${revokedAt}`;
}

/** The alert's body; the footer is added per recipient. */
export function keyRevokedMail(key: ApiKeyRow, organization: string | null): Omit<SystemMailBody, "reason"> {
  return {
    heading: `Key revoked: ${key.name}`,
    paragraphs: [`The ${key.mode} key named ${key.name} is revoked. Anything using it can't send anymore.`],
    facts: [
      ["Key", key.name],
      ["Organization", organization ?? "None (admin key)"],
    ],
  };
}

export function KeyRevokedEmail({ apiKey, organization, reason }: { apiKey: ApiKeyRow; organization: string | null; reason: string }) {
  return <SystemMail {...keyRevokedMail(apiKey, organization)} reason={reason} />;
}

/** Sends the alert for a key that was just revoked. `key` must already carry `revokedAt`. */
export async function sendKeyRevokedAlert(key: ApiKeyRow): Promise<void> {
  const organization = key.organizationId ? await organizationName(key.organizationId) : null;
  await sendSystemAlert({
    subject: `Key revoked: ${key.name}`,
    email: (reason) => <KeyRevokedEmail apiKey={key} organization={organization} reason={reason} />,
    idempotencyKey: idempotencyKey(key),
  });
}
