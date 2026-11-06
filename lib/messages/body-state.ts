/** What reading a sent message's body found. Dependency-free, so the dashboard's client views can name it. */
export interface BodyAttachment {
  filename: string;
  contentType: string;
  bytes: number;
}

export type MessageBody =
  | { state: "available"; html: string | null; text: string | null; attachments: BodyAttachment[] }
  /** Key shredded by the retention sweep; purgedAt is the stamp. Null purgedAt means a pre-encryption row. */
  | { state: "purged"; purgedAt: Date | null }
  /** Held a credential, so no read returns it. `reason` completes "it contained ...". */
  | { state: "withheld"; reason: string }
  /** Past the retention window; the bucket's lifecycle rule collects the inert object. */
  | { state: "expired"; keptUntil: Date }
  /** Storage couldn't answer. Distinct from gone, because it may come back. */
  | { state: "unavailable" };

export type BodyGone = Exclude<MessageBody, { state: "available" }>;

/** The sentence every surface shows for a withheld body. `reason` completes "it contained ...", and may be empty. */
export function withheldSentence(reason: string): string {
  return reason ? `It was marked as sensitive because it contained ${reason}.` : "It was marked as sensitive.";
}

/** The API's `body_unavailable.message` for a withheld body. */
export function withheldBodyMessage(reason: string): string {
  const sentence = withheldSentence(reason);
  return `Body withheld: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}
