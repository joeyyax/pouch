import { sendSystemAlert } from "@/lib/mail/system";
import { SystemMail, type SystemMailBody } from "@/lib/mail/template";
import { keyName, organizationName } from "./names";

export interface BulkFanoutCrossing {
  organizationId: string;
  apiKeyId: string;
  bodyHash: string;
  /** UTC calendar day, from the database's clock — the same window the detection counts against. */
  day: string;
  count: number;
  threshold: number;
}

export interface BulkFanoutNames {
  key: string;
  organization: string;
}

/**
 * One state change, one alert: keyed on the key, the body and the day. The count only climbs
 * within that day, so once it's crossed the threshold every later call for the same body finds
 * it already past — the caller only reaches this on the call that did the crossing.
 */
function idempotencyKey(crossing: BulkFanoutCrossing): string {
  return `bulk-fanout:${crossing.apiKeyId}:${crossing.bodyHash}:${crossing.day}`;
}

/** The alert's body; the footer is added per recipient. */
export function bulkFanoutMail(crossing: BulkFanoutCrossing, names: BulkFanoutNames): Omit<SystemMailBody, "reason"> {
  return {
    heading: `One message reached ${crossing.count} recipients`,
    paragraphs: [
      `The key ${names.key} sent the same message body to ${crossing.count} recipients on ${crossing.day}, past the ${crossing.threshold}-recipient bulk threshold.`,
      "Mailbox providers treat mail like this as bulk. It keeps sending only with a List-Unsubscribe header.",
    ],
    facts: [
      ["Key", names.key],
      ["Organization", names.organization],
      ["Day (UTC)", crossing.day],
    ],
  };
}

export function BulkFanoutEmail({ crossing, names, reason }: { crossing: BulkFanoutCrossing; names: BulkFanoutNames; reason: string }) {
  return <SystemMail {...bulkFanoutMail(crossing, names)} reason={reason} />;
}

/** Sends the alert for a body hash that just fanned out past the bulk threshold for the day. */
export async function sendBulkFanoutAlert(crossing: BulkFanoutCrossing): Promise<void> {
  const names = { key: await keyName(crossing.apiKeyId), organization: await organizationName(crossing.organizationId) };
  await sendSystemAlert({
    subject: `Bulk fan-out past ${crossing.threshold}: key ${names.key}`,
    email: (reason) => <BulkFanoutEmail crossing={crossing} names={names} reason={reason} />,
    idempotencyKey: idempotencyKey(crossing),
  });
}
