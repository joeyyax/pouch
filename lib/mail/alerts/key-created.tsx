import type { apiKeys } from "@/lib/db/schema";
import { sendSystemAlert } from "@/lib/mail/system";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { organizationName } from "./names";

type ApiKeyRow = typeof apiKeys.$inferSelect;

/** A key is minted once, so its id alone identifies the state change. */
function idempotencyKey(key: ApiKeyRow): string {
  return `key-created:${key.id}`;
}

/** The alert's body; the footer is added per recipient. */
export function keyCreatedMail(key: ApiKeyRow, organization: string | null): Omit<SystemMailBody, "reason"> {
  const scope = key.domainIds.length === 0 ? "every domain in the organization" : `${key.domainIds.length} domain(s)`;
  return {
    heading: `New ${key.mode} key: ${key.name}`,
    paragraphs: [`A ${key.mode} key named ${key.name} was created. It can send from ${scope}.`],
    facts: [
      ["Key", key.name],
      ["Organization", organization ?? "None (admin key)"],
    ],
  };
}

export function KeyCreatedEmail({ apiKey, organization, reason }: { apiKey: ApiKeyRow; organization: string | null; reason: string }) {
  return <SystemMail {...keyCreatedMail(apiKey, organization)} reason={reason} />;
}

/** Sends the alert for a key that was just minted, live or test mode. */
export async function sendKeyCreatedAlert(key: ApiKeyRow): Promise<void> {
  const organization = key.organizationId ? await organizationName(key.organizationId) : null;
  await sendSystemAlert({
    subject: `Key created: ${key.name}`,
    email: (reason) => <KeyCreatedEmail apiKey={key} organization={organization} reason={reason} />,
    idempotencyKey: idempotencyKey(key),
  });
}
