import {
  CreateReceiptRuleCommand,
  DeleteReceiptRuleCommand,
  DescribeActiveReceiptRuleSetCommand,
  SetReceiptRulePositionCommand,
  UpdateReceiptRuleCommand,
  type ReceiptRule,
} from "@aws-sdk/client-ses";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import type { Adapter, InboundRoute, ProposedDnsRecord, ReceivedMail, SignedRequest } from "../types";
import { InboundUnavailableError } from "../types";
import { log, resourceName, type SesContext } from "./client";
import { reasonOf } from "./errors";
import { parseEnvelope } from "./sns";

/** Where received mail lands in the bucket: `<prefix><domain id>/<SES message id>`. */
export const INBOUND_KEY_PREFIX = "inbound/";

const RULE_MISSING_NAMES = new Set(["RuleDoesNotExistException", "RuleSetDoesNotExistException"]);
const RECEIPT_TARGET_NAMES = new Set(["InvalidS3ConfigurationException", "InvalidSnsTopicException"]);

/** Every rule Pouch writes is named with this, so it can tell its own rules from the account's. */
export const INBOUND_RULE_PREFIX = "mail-inbound-";

const NO_OBJECT_NAMES = new Set(["NoSuchKey", "NotFound"]);

/** The domain id and SES message id a received object's key was routed under, or null for a key outside the prefix. */
export function inboundKeyParts(objectKey: string): { domainId: string; messageId: string } | null {
  if (!objectKey.startsWith(INBOUND_KEY_PREFIX)) return null;
  const [domainId, messageId, ...rest] = objectKey.slice(INBOUND_KEY_PREFIX.length).split("/");
  if (!domainId || !messageId || rest.length > 0) return null;
  return { domainId, messageId };
}

interface SesVerdict {
  status?: string;
}

interface SesReceivedPayload {
  notificationType?: string;
  mail?: { messageId?: string };
  receipt?: {
    recipients?: string[];
    spamVerdict?: SesVerdict;
    virusVerdict?: SesVerdict;
    spfVerdict?: SesVerdict;
    dkimVerdict?: SesVerdict;
    dmarcVerdict?: SesVerdict;
    action?: { type?: string; bucketName?: string; objectKey?: string };
  };
}

function verdictOfReceipt(verdict: SesVerdict | undefined): string | null {
  return verdict?.status ? verdict.status.toLowerCase() : null;
}

export function createInbound(context: SesContext): NonNullable<Adapter["inbound"]> {
  const { region, inboundBucket, topicArn, receiptClient, s3Client, paced } = context;

  /** The account's active rule set. Pouch never creates, activates or replaces one: that's account-wide. */
  async function activeRuleSet(): Promise<{ name: string; rules: ReceiptRule[] }> {
    const active = await paced(() => receiptClient.send(new DescribeActiveReceiptRuleSetCommand({})));
    if (!active.Metadata?.Name) {
      throw new InboundUnavailableError(`SES has no active receipt rule set in ${region}. An admin creates and activates one.`);
    }
    return { name: active.Metadata.Name, rules: active.Rules ?? [] };
  }

  /**
   * One receipt rule per domain: the host's mail goes to the bucket, the row's own topic hears about
   * it, and the set stops there. Pouch's rules sit ahead of the account's own, so a catch-all that
   * stops can't swallow a Pouch host's mail.
   */
  async function openInbound(route: InboundRoute): Promise<Record<string, string>> {
    if (!inboundBucket) throw new InboundUnavailableError("This domain's provider has no inbound bucket configured. An admin sets one on the provider.");
    if (!topicArn) throw new InboundUnavailableError("This domain's provider hasn't finished setting up its events. Verify the domain, then try again.");

    const ruleSet = await activeRuleSet();
    const name = resourceName(route.domainId, INBOUND_RULE_PREFIX.slice(0, -1));
    const rule: ReceiptRule = {
      Name: name,
      Enabled: true,
      Recipients: [route.host],
      ScanEnabled: true,
      TlsPolicy: "Optional",
      Actions: [
        { S3Action: { BucketName: inboundBucket, ObjectKeyPrefix: `${INBOUND_KEY_PREFIX}${route.domainId}/`, TopicArn: topicArn } },
        { StopAction: { Scope: "RuleSet" } },
      ],
    };
    const index = ruleSet.rules.findIndex((one) => one.Name === name);
    const behindForeignRule = ruleSet.rules.slice(0, Math.max(index, 0)).some((one) => !one.Name?.startsWith(INBOUND_RULE_PREFIX));
    try {
      // Without `After`, SES puts a new rule first.
      await paced(() =>
        receiptClient.send(
          index >= 0 ? new UpdateReceiptRuleCommand({ RuleSetName: ruleSet.name, Rule: rule }) : new CreateReceiptRuleCommand({ RuleSetName: ruleSet.name, Rule: rule }),
        ),
      );
      if (behindForeignRule) {
        await paced(() => receiptClient.send(new SetReceiptRulePositionCommand({ RuleSetName: ruleSet.name, RuleName: name })));
      }
    } catch (err) {
      // SES checks it can write the bucket and publish to the topic before it takes the rule.
      if (RECEIPT_TARGET_NAMES.has((err as Error).name)) throw new InboundUnavailableError(`SES can't deliver received mail yet: ${reasonOf(err)}`);
      throw err;
    }
    return { ruleSet: ruleSet.name, rule: name };
  }

  async function closeInbound(route: InboundRoute, stored: Record<string, string>): Promise<void> {
    const ruleSet = stored.ruleSet;
    if (!ruleSet) return;
    try {
      await paced(() =>
        receiptClient.send(new DeleteReceiptRuleCommand({ RuleSetName: ruleSet, RuleName: stored.rule ?? resourceName(route.domainId, INBOUND_RULE_PREFIX.slice(0, -1)) })),
      );
    } catch (err) {
      if (!RULE_MISSING_NAMES.has((err as Error).name)) throw err;
    }
  }

  /** A message in the inbound bucket, read and deleted only when asked. */
  function storedMail(objectKey: string): ReceivedMail | null {
    const parts = inboundKeyParts(objectKey);
    if (!parts || !inboundBucket) return null;
    const object = { Bucket: inboundBucket, Key: objectKey };
    return {
      domainId: parts.domainId,
      providerMessageId: parts.messageId,
      recipients: [],
      verdicts: null,
      async read() {
        try {
          const stored = await s3Client.send(new GetObjectCommand(object));
          const bytes = await stored.Body?.transformToByteArray();
          if (!bytes) throw new Error(`Received mail ${objectKey} has no body.`);
          return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        } catch (err) {
          if (NO_OBJECT_NAMES.has((err as Error).name)) return null;
          throw err;
        }
      },
      async discard() {
        await s3Client.send(new DeleteObjectCommand(object));
      },
    };
  }

  /** A receipt rule's S3 action, announced on the row's topic. Nothing is read until ingest asks. */
  async function receivedMail(request: SignedRequest): Promise<ReceivedMail | null> {
    const envelope = parseEnvelope(request.rawBody);
    if (!envelope || envelope.Type !== "Notification" || !topicArn || envelope.TopicArn !== topicArn) return null;

    let payload: SesReceivedPayload;
    try {
      payload = JSON.parse(envelope.Message) as SesReceivedPayload;
    } catch {
      return null;
    }
    if (payload.notificationType !== "Received") return null;

    const action = payload.receipt?.action;
    if (action?.type !== "S3" || !action.bucketName || !action.objectKey) return null;
    if (action.bucketName !== inboundBucket) {
      log.warn(`ignoring received mail in ${action.bucketName}, which isn't this provider's inbound bucket`);
      return null;
    }
    const mail = storedMail(action.objectKey);
    if (!mail) return null;

    const receipt = payload.receipt!;
    return {
      ...mail,
      recipients: receipt.recipients ?? [],
      verdicts: {
        spam: verdictOfReceipt(receipt.spamVerdict),
        virus: verdictOfReceipt(receipt.virusVerdict),
        spf: verdictOfReceipt(receipt.spfVerdict),
        dkim: verdictOfReceipt(receipt.dkimVerdict),
        dmarc: verdictOfReceipt(receipt.dmarcVerdict),
      },
    };
  }

  return {
    records(host: string): ProposedDnsRecord[] {
      return [{ type: "MX", name: host, value: `inbound-smtp.${region}.amazonaws.com`, priority: 10, required: false }];
    },
    open: openInbound,
    close: closeInbound,
    received: receivedMail,
    stored: storedMail,
  };
}
