import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SESClient } from "@aws-sdk/client-ses";
import { S3Client } from "@aws-sdk/client-s3";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SNSClient } from "@aws-sdk/client-sns";
import { STSClient } from "@aws-sdk/client-sts";
import type { z } from "zod";
import { logger } from "@/lib/logger";
import { waitForApiPermit } from "@/lib/providers/send-rate";
import { awsRequestHandler } from "@/lib/fetch-timeout";
import type { AdapterOptions, ProviderSettings } from "../types";
import { API_RETRY, ApiRateTimeoutError, isThrottle, statusOf } from "./errors";
import type { credentialsSchema, SesSettings } from "./settings";

export const log = logger.child("provider:ses");

// Every AWS call this adapter makes. Inside the worker's five-minute lock (lib/messages/queue.ts).
export const SEND_TIMEOUT_MS = 60_000;

/** `arn:aws:ses:<region>:<account>:tenant/<name>/<id>`. */
function arnParts(arn: string): { region: string; account: string } {
  const [, , , region = "", account = ""] = arn.split(":");
  return { region, account };
}

/** A resource name SES and SNS both accept: letters, digits and dashes. */
export function resourceName(accountId: string, prefix = "mail-events"): string {
  return `${prefix}-${accountId.replace(/[^a-zA-Z0-9]+/g, "-")}`.slice(0, 64);
}

/** The clients, pacing and settings every part of the adapter shares. */
export function sesContext(credentials: Record<string, string>, settings: ProviderSettings, accountId: string, options: AdapterOptions) {
  const { accessKeyId, secretAccessKey, region, inboundBucket } = credentials as unknown as z.infer<typeof credentialsSchema>;
  const { configurationSetName, topicArn, tenantName, sharing } = settings as SesSettings;

  const clientConfig = {
    region,
    credentials: { accessKeyId, secretAccessKey },
    ...awsRequestHandler(SEND_TIMEOUT_MS),
  };
  const sesClient = new SESv2Client(clientConfig);
  // Every attempt draws a permit, so the SDK's own retries are off here.
  const controlClient = new SESv2Client({ ...clientConfig, maxAttempts: 1 });
  const apiSubject = options.apiRateSubject ?? `ses:key:${accessKeyId}`;

  /** Runs a non-send SES call within the account's one-a-second limit, retrying throttles and outages. */
  async function paced<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      if (!(await waitForApiPermit(apiSubject, API_RETRY.maxWaitMs))) throw new ApiRateTimeoutError(apiSubject);
      try {
        return await call();
      } catch (err) {
        if (attempt >= API_RETRY.attempts || !(isThrottle(err) || statusOf(err) >= 500)) throw err;
        const delayMs = API_RETRY.baseMs * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  const snsClient = new SNSClient(clientConfig);
  const receiptClient = new SESClient({ ...clientConfig, maxAttempts: 1 });
  const s3Client = new S3Client(clientConfig);
  const stsClient = new STSClient(clientConfig);
  const cloudWatchClient = new CloudWatchClient(clientConfig);

  function sesArn(anchor: string, resource: string): string {
    const { region: arnRegion, account } = arnParts(anchor);
    return `arn:aws:ses:${arnRegion || region}:${account}:${resource}`;
  }

  return {
    settings,
    accountId,
    options,
    region,
    inboundBucket,
    configurationSetName,
    topicArn,
    tenantName,
    sharing,
    clientConfig,
    sesClient,
    controlClient,
    snsClient,
    receiptClient,
    s3Client,
    stsClient,
    cloudWatchClient,
    paced,
    sesArn,
  };
}

export type SesContext = ReturnType<typeof sesContext>;
