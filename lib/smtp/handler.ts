import { ZodError } from "zod";
import { simpleParser } from "mailparser";
import type { SMTPServerAddress, SMTPServerDataStream, SMTPServerOptions } from "smtp-server";
import { authenticateSecret, requireOrganizationKey } from "@/lib/api/keys";
import { ApiError } from "@/lib/api/errors";
import { recordKeyUse } from "@/lib/api/keys";
import { assertWithinRateLimit, consumeRateLimit } from "@/lib/api/rate-limit";
import { acceptMessage } from "@/lib/messages/create";
import { notifyQueued } from "@/lib/messages/queue";
import { sendEmailSchema } from "@/lib/schemas/email";
import { validationError } from "@/lib/schemas/validation-error";
import { logger } from "@/lib/logger";
import { SmtpProtocolError, toSmtpError } from "./errors";
import { candidateFromParsedMail, isValidEnvelopeAddress } from "./parse";
import type { SmtpSession } from "./session";
import { reportError } from "@/lib/errors/report";
import { safeErrorMessage } from "@/lib/errors/scrub";

/**
 * A failure the sending client caused mid-DATA: a dropped connection, a timeout, malformed MIME
 * that mailparser refuses. Routine traffic on a public SMTP port — scanners and flaky clients do
 * this all day — so it gets a 451 and a log line, never an error report.
 */
function isClientStreamFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE") return true;
  return /aborted|socket hang up|unexpected end|premature close|stream/i.test(err.message);
}

const log = logger.child("smtp:handler");

const onAuth: NonNullable<SMTPServerOptions["onAuth"]> = (auth, session, callback) => {
  if (auth.method !== "PLAIN" && auth.method !== "LOGIN") {
    callback(new SmtpProtocolError({ code: 504, message: "Unrecognized authentication type." }));
    return;
  }
  authenticateSecret(auth.password ?? "")
    .then(async (key) => {
      // SMTP AUTH is this path's authenticated request, so it records the same as an HTTP one.
      await recordKeyUse(key.id).catch((err: unknown) => {
        log.warn(`couldn't record key use for ${key.id}: ${safeErrorMessage(err)}`);
      });
      (session as SmtpSession).apiKey = requireOrganizationKey(key);
      callback(null, { user: key.id });
    })
    .catch((err: unknown) => callback(toSmtpError(err)));
};

const onMailFrom: NonNullable<SMTPServerOptions["onMailFrom"]> = (_address, _session, callback) => {
  // Only used as a fallback `from` when a message carries no From header at all — accept
  // whatever the client sends and let the DATA-stage validation decide.
  callback();
};

const onRcptTo: NonNullable<SMTPServerOptions["onRcptTo"]> = (address: SMTPServerAddress, _session, callback) => {
  if (!isValidEnvelopeAddress(address.address)) {
    callback(new SmtpProtocolError({ code: 501, message: `Recipient address isn't valid: ${address.address}.` }));
    return;
  }
  callback();
};

const onData: NonNullable<SMTPServerOptions["onData"]> = (stream: SMTPServerDataStream, session, callback) => {
  void (async () => {
    // smtp-server won't send a reply until this stream has ended, so it's parsed — and
    // fully drained — before any check that might reject the message. Rejecting first and
    // leaving the stream unread stalls the connection: the client keeps writing DATA into a
    // socket nothing is reading, and the final reply never arrives.
    const mail = await simpleParser(stream);

    const smtpSession = session as SmtpSession;
    const apiKey = smtpSession.apiKey;
    if (!apiKey) {
      // authOptional is false, so smtp-server never reaches DATA without a successful AUTH —
      // this is a defensive floor, not a path a real client can hit.
      throw new ApiError("invalid_key", "This key isn't valid.");
    }

    // Same per-minute ceiling `withApiKey` enforces on every HTTP request — one SMTP message
    // in is one request against it, counted here rather than per RCPT TO or per connection.
    assertWithinRateLimit(await consumeRateLimit(apiKey.id, apiKey.rateLimit));

    const envelope = {
      mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : null,
      rcptTo: session.envelope.rcptTo.map((recipient) => recipient.address),
    };
    const candidate = candidateFromParsedMail(mail, envelope);

    let parsed;
    try {
      parsed = sendEmailSchema.parse(candidate);
    } catch (err) {
      if (err instanceof ZodError) throw validationError(err, candidate);
      throw err;
    }

    const { message, replayed } = await acceptMessage(apiKey, parsed, null);

    // The message is committed. The nudge may not turn an accepted send into a rejection — but
    // a silent failure here is how a message sits queued with nothing saying why.
    if (!replayed) {
      await notifyQueued(message.id).catch((err: unknown) => {
        log.warn(`couldn't nudge the worker for ${message.id}: ${safeErrorMessage(err)}`);
      });
    }

    return message.id;
  })()
    .then((messageId) => callback(null, `Queued as ${messageId}`))
    .catch((err: unknown) => {
      // An ApiError or SmtpProtocolError is the sender's problem and becomes a reply they can
      // read. A client that drops mid-DATA or sends malformed MIME makes simpleParser reject
      // with a plain Error, and on a public SMTP port that is routine traffic, not an incident —
      // so it is logged and not reported. What's left is ours: Postgres down, storage
      // unreachable, where the sender's correct 451 is the only trace unless this reports it.
      if (!(err instanceof ApiError) && !(err instanceof SmtpProtocolError)) {
        log.warn(`SMTP DATA handling failed: ${safeErrorMessage(err)}`);
        if (!isClientStreamFailure(err)) reportError(err, { errorCode: "smtp_data_failed" });
      }
      callback(toSmtpError(err));
    });
};

/** Callbacks shared by every listener (587 and the opt-in 465) — TLS and port options are added by `lib/smtp/server.ts`. */
export const smtpHandlers: Pick<SMTPServerOptions, "onAuth" | "onMailFrom" | "onRcptTo" | "onData"> = {
  onAuth,
  onMailFrom,
  onRcptTo,
  onData,
};
