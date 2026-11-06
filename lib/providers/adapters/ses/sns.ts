import { SetTopicAttributesCommand, type SNSClient } from "@aws-sdk/client-sns";

/**
 * Lets SES publish to the topic. Without it SES has nowhere to deliver its events, and the
 * account condition keeps another account's SES from publishing to ours.
 */
export function publishPolicy(topicArn: string): Record<string, unknown> {
  const account = topicArn.split(":")[4] ?? "";
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "allow-ses-publish",
        Effect: "Allow",
        Principal: { Service: "ses.amazonaws.com" },
        Action: "sns:Publish",
        Resource: topicArn,
        Condition: { StringEquals: { "AWS:SourceAccount": account } },
      },
    ],
  };
}

/** Lets this account's EventBridge rule, and nothing else, publish tenant status to the topic. */
export function statusPolicy(topicArn: string, ruleArn: string): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "allow-eventbridge-publish",
        Effect: "Allow",
        Principal: { Service: "events.amazonaws.com" },
        Action: "sns:Publish",
        Resource: topicArn,
        Condition: { ArnEquals: { "aws:SourceArn": ruleArn } },
      },
    ],
  };
}

/**
 * Ten retries over about 52 minutes: three at 20 s, five backing off exponentially, two at 15
 * minutes. The default is three tries inside a minute, which a deploy outlasts — those events
 * were gone, and the sweep then marked delivered messages unconfirmed. Set on the topic so
 * existing subscriptions pick it up.
 *
 * SNS refuses a policy whose retries can total more than 3600 s, so the budget is the hour, not
 * the last delay.
 */
export const DELIVERY_POLICY = {
  http: {
    defaultHealthyRetryPolicy: {
      minDelayTarget: 20,
      maxDelayTarget: 900,
      numRetries: 10,
      numNoDelayRetries: 0,
      numMinDelayRetries: 3,
      numMaxDelayRetries: 2,
      backoffFunction: "exponential",
    },
    disableSubscriptionOverrides: false,
  },
};

export function setDeliveryPolicy(client: SNSClient, topicArn: string) {
  return client.send(
    new SetTopicAttributesCommand({
      TopicArn: topicArn,
      AttributeName: "DeliveryPolicy",
      AttributeValue: JSON.stringify(DELIVERY_POLICY),
    }),
  );
}

export interface SnsEnvelope extends Record<string, string> {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Signature: string;
  SigningCertURL: string;
}

export function parseEnvelope(rawBody: string): SnsEnvelope | null {
  try {
    const body = JSON.parse(rawBody) as SnsEnvelope;
    if (!body || typeof body !== "object" || typeof body.Type !== "string") return null;
    return body;
  } catch {
    return null;
  }
}
