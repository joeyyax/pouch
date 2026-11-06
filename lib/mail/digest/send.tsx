/**
 * Runs one cadence for one window: reads the summary once, then sends it to every opted-in
 * operator. Idempotent per recipient — `sendSystemMail`'s idempotency key is
 * `digest:<cadence>:<windowKey>:<userId>`, so a worker restarting mid-run resumes rather than
 * re-sending to operators it already reached (see `lib/messages/idempotency.ts`).
 */
import { logger } from "@/lib/logger";
import { sendSystemMail, SystemMailNotConfiguredError } from "@/lib/mail/system";
import type { DigestCadence, DigestWindow } from "./cadence";
import { digestSubject } from "./copy";
import { DigestEmail } from "./email";
import { readDigestSummary } from "./metrics";
import { listDigestRecipients } from "./preferences";
import { unsubscribeUrl } from "./unsubscribe";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("mail:digest");

function idempotencyKey(window: DigestWindow, userId: string): string {
  return `digest:${window.cadence}:${window.windowKey}:${userId}`;
}

/**
 * Computes the summary once and mails every opted-in operator. Returns how many it sent.
 * Sends nothing, to no one, when the window is empty — a digest with nothing in it doesn't
 * send (`docs/decisions.md`, the same rule an as-needed alert doesn't get to break).
 */
export async function runDigest(window: DigestWindow): Promise<number> {
  const summary = await readDigestSummary(window);
  if (!summary) {
    log.info(`${window.cadence} digest for ${window.windowKey}: nothing sent in the window, skipping`);
    return 0;
  }

  const recipients = await listDigestRecipients(window.cadence);
  if (recipients.length === 0) return 0;

  const subject = digestSubject(summary);
  let sent = 0;

  for (const recipient of recipients) {
    const url = unsubscribeUrl(recipient.userId, window.cadence);
    try {
      await sendSystemMail({
        to: recipient.email,
        subject,
        email: <DigestEmail summary={summary} unsubscribeUrl={url} />,
        headers: {
          "List-Unsubscribe": `<${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        tags: ["system-digest", `digest-${window.cadence}`],
        idempotencyKey: idempotencyKey(window, recipient.userId),
      });
      sent += 1;
    } catch (err) {
      if (err instanceof SystemMailNotConfiguredError) throw err;
      log.warn(`sending the ${window.cadence} digest to ${recipient.userId} failed: ${safeErrorMessage(err)}`);
    }
  }

  return sent;
}

export type { DigestCadence };
