import { CreateConfigurationSetCommand, CreateConfigurationSetEventDestinationCommand } from "@aws-sdk/client-sesv2";
import { EventBridgeClient, PutRuleCommand, PutTargetsCommand } from "@aws-sdk/client-eventbridge";
import { CreateTopicCommand, SetTopicAttributesCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import type { Adapter, ConfiguredEvents, SetupContext } from "../types";
import { resourceName, type SesContext } from "./client";
import { tolerateExisting } from "./errors";
import { isConfigured } from "./settings";
import { publishPolicy, setDeliveryPolicy, statusPolicy } from "./sns";
import { TENANT_STATUS_KINDS, type SesTenants } from "./tenants";

/** SES event types we ask for. Opens and clicks are deliberately absent. */
const EVENT_TYPES = ["SEND", "DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "DELIVERY_DELAY"] as const;

export function createSetup(context: SesContext, tenants: SesTenants): NonNullable<Adapter["setup"]> {
  const { settings, accountId, clientConfig, controlClient, snsClient, paced, sesArn, tenantName, sharing, configurationSetName } = context;
  const { ensureTenant, associate, teardownTenant } = tenants;

  async function configureTenant(name: string, context: SetupContext): Promise<ConfiguredEvents> {
    const arn = await ensureTenant(name);
    await context.save({ tenantArn: arn });

    const configSet = configurationSetName ?? resourceName(accountId);
    await tolerateExisting(paced(() => controlClient.send(new CreateConfigurationSetCommand({ ConfigurationSetName: configSet }))));
    await context.save({ configurationSetName: configSet });
    await associate(name, sesArn(arn, `configuration-set/${configSet}`));
    await context.save({ configurationSetAssociated: "true" });
    for (const identity of context.identities ?? []) await associate(name, sesArn(arn, `identity/${identity}`));

    const events = await configureAccountEvents(configSet, context);
    return { settings: { ...events.settings, tenantArn: arn, configurationSetAssociated: "true" } };
  }

  /** Topic, subscription and the EventBridge rule that carries tenant status to it. */
  async function configureShared(context: SetupContext): Promise<ConfiguredEvents> {
    const name = resourceName(accountId, "mail-tenant-status");
    const topic = await snsClient.send(new CreateTopicCommand({ Name: name }));
    const arn = topic.TopicArn;
    if (!arn) throw new Error("SNS created the topic without an ARN.");
    await context.save({ topicArn: arn });

    const events = new EventBridgeClient(clientConfig);
    const rule = await events.send(
      new PutRuleCommand({
        Name: name,
        State: "ENABLED",
        EventPattern: JSON.stringify({ source: ["aws.ses"], "detail-type": Object.keys(TENANT_STATUS_KINDS) }),
      }),
    );
    const ruleArn = rule.RuleArn;
    if (!ruleArn) throw new Error("EventBridge created the rule without an ARN.");

    await snsClient.send(
      new SetTopicAttributesCommand({ TopicArn: arn, AttributeName: "Policy", AttributeValue: JSON.stringify(statusPolicy(arn, ruleArn)) }),
    );
    await snsClient.send(new SetTopicAttributesCommand({ TopicArn: arn, AttributeName: "SignatureVersion", AttributeValue: "2" }));
    await setDeliveryPolicy(snsClient, arn);
    await snsClient.send(new SubscribeCommand({ TopicArn: arn, Protocol: "https", Endpoint: context.webhookUrl }));

    const targets = await events.send(new PutTargetsCommand({ Rule: name, Targets: [{ Id: "tenant-status", Arn: arn }] }));
    if (targets.FailedEntryCount) {
      throw new Error(`EventBridge refused the target: ${targets.FailedEntries?.[0]?.ErrorMessage ?? "unknown reason"}`);
    }

    return { settings: { topicArn: arn, eventRuleArn: ruleArn } };
  }

  /**
   * Creates the configuration set's topic and event destination. Every step tolerates the resource
   * already being there, so the whole call can be re-run after a failure part way.
   */
  async function configureAccountEvents(name: string, context: SetupContext): Promise<ConfiguredEvents> {
    await tolerateExisting(paced(() => controlClient.send(new CreateConfigurationSetCommand({ ConfigurationSetName: name }))));

    // CreateTopic returns the existing ARN for a name that's already taken, so the concurrent
    // call converges here rather than diverging.
    const topic = await snsClient.send(new CreateTopicCommand({ Name: resourceName(accountId) }));
    const arn = topic.TopicArn;
    if (!arn) throw new Error("SNS created the topic without an ARN.");

    // SNS posts the subscription confirmation within a second or so, and the receiver refuses
    // to confirm a topic it doesn't know. Both names are stored before anything can arrive.
    await context.save({ configurationSetName: name, topicArn: arn });

    await snsClient.send(
      new SetTopicAttributesCommand({
        TopicArn: arn,
        AttributeName: "Policy",
        AttributeValue: JSON.stringify(publishPolicy(arn)),
      }),
    );

    // A topic defaults to SignatureVersion 1 (SHA1). Set before subscribing, so even the
    // confirmation SNS sends next is signed with 2 — verifyEnvelope refuses anything else.
    await snsClient.send(
      new SetTopicAttributesCommand({ TopicArn: arn, AttributeName: "SignatureVersion", AttributeValue: "2" }),
    );

    await setDeliveryPolicy(snsClient, arn);

    await snsClient.send(
      new SubscribeCommand({ TopicArn: arn, Protocol: "https", Endpoint: context.webhookUrl }),
    );

    await tolerateExisting(
      paced(() => controlClient.send(
        new CreateConfigurationSetEventDestinationCommand({
          ConfigurationSetName: name,
          EventDestinationName: "delivery-events",
          EventDestination: {
            Enabled: true,
            MatchingEventTypes: [...EVENT_TYPES],
            SnsDestination: { TopicArn: arn },
          },
        }),
      )),
    );

    return { settings: { configurationSetName: name, topicArn: arn } };
  }

  return {
    isConfigured,

    /**
     * Builds the event plumbing: the configuration set, topic and event destination for an
     * ordinary account or a tenant, or the tenant status rule for a shared account.
     *
     * Both resources are named after the account. Two domains created at once on the same new
     * account converge on one topic; naming them after the triggering domain made two, and the
     * loser published to a topic `verifyEnvelope` rejects.
     */
    async configureEvents(_domain: string, context: SetupContext): Promise<ConfiguredEvents> {
      if (sharing === "operator") return configureShared(context);
      const configured = tenantName
        ? await configureTenant(tenantName, context)
        : await configureAccountEvents(configurationSetName ?? resourceName(accountId), context);
      return settings.rebuild ? { settings: { ...configured.settings, rebuild: "" } } : configured;
    },

    ...(tenantName ? { teardown: () => teardownTenant(tenantName) } : {}),
  };
}
