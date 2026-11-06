import type { SMTPServerSession } from "smtp-server";
import type { OrganizationKeyRow } from "@/lib/api/keys";

/** The session `smtp-server` hands every callback, extended with what `onAuth` resolves. */
export interface SmtpSession extends SMTPServerSession {
  apiKey?: OrganizationKeyRow;
}
