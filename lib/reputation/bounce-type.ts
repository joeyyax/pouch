/** SES bounce subtypes in plain words. General and Undetermined say nothing the reason doesn't. */
const SUBTYPE_LABEL: Record<string, string | null> = {
  General: null,
  Undetermined: null,
  NoEmail: "Mailbox doesn't exist",
  Suppressed: "On the provider's suppression list",
  OnProviderSuppressionList: "On the provider's suppression list",
  MailboxFull: "Mailbox full",
  MessageTooLarge: "Message too large",
  ContentRejected: "Content rejected",
  AttachmentRejected: "Attachment rejected",
};

/** The subtype of a stored `Type/SubType`, in plain words. Null when it adds nothing. */
export function bounceTypeLabel(bounceType: string | null): string | null {
  const subtype = bounceType?.split("/")[1];
  if (!subtype) return null;
  return subtype in SUBTYPE_LABEL ? SUBTYPE_LABEL[subtype]! : subtype;
}
