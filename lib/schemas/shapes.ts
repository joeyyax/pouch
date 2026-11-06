/** What each resource's reads can return. Messages and inbound mail are declared beside their own schemas. */
import { defineShape } from "@/lib/api/shape";

const DOMAIN_KEYS = [
  "id",
  "name",
  "status",
  "dns_records",
  "missing_records",
  "setup",
  "errors",
  "verified_at",
  "last_checked_at",
  "created_at",
  "provider_id",
  "pending",
  "stall",
  "bulk_allowed",
  "layout",
  "standing",
  "standing_reason",
] as const;

const DOMAIN_STANDING = { keys: ["standing", "standing_reason"], description: "reputation over the last 7 days, computed on read" } as const;

/** `GET /v1/domains`. */
export const domainShape = defineShape({
  resource: "domain",
  keys: DOMAIN_KEYS,
  defaults: DOMAIN_KEYS,
  expansions: { standing: DOMAIN_STANDING },
});

/** `GET /v1/domains/:id`: the list's shape, plus the reputation detail on request. */
export const domainReadShape = defineShape({
  resource: "domain",
  keys: [...DOMAIN_KEYS, "reputation", "dmarc"],
  defaults: DOMAIN_KEYS,
  expansions: {
    standing: DOMAIN_STANDING,
    dmarc: {
      keys: ["dmarc"],
      description: "the DMARC record read live: its status, policy and report addresses, whether SPF and DKIM align and what needs a change",
    },
    reputation: {
      keys: ["reputation"],
      description:
        "the reputation detail: findings, 7- and 30-day rates against every line, recent bounce and complaint reasons, sending patterns, blocklists, provider findings and tenant counts. Null until the domain has verified",
    },
  },
});

const DMARC_REPORT_KEYS = ["id", "domain_id", "reporter", "reporter_email", "report_id", "begins_at", "ends_at", "policy", "message_count", "received_at"] as const;
/** `GET /v1/domains/:id/dmarc_reports`. */
export const dmarcReportShape = defineShape({
  resource: "DMARC report",
  keys: [...DMARC_REPORT_KEYS, "records"],
  defaults: DMARC_REPORT_KEYS,
  expansions: { records: { keys: ["records"], description: "each source address the report names, its message count, who sent it and how SPF and DKIM fared" } },
});

const KEY_KEYS = ["id", "name", "mode", "secret_prefix", "domain_ids", "rate_limit", "last_used_at", "revoked_at", "created_at"] as const;
export const keyShape = defineShape({ resource: "key", keys: KEY_KEYS, defaults: KEY_KEYS, expansions: {} });

const ENDPOINT_KEYS = ["id", "key_id", "url", "events", "description", "disabled", "last_success_at", "last_failure_at", "created_at"] as const;
export const webhookEndpointShape = defineShape({ resource: "webhook endpoint", keys: ENDPOINT_KEYS, defaults: ENDPOINT_KEYS, expansions: {} });

const SUPPRESSION_KEYS = ["id", "address", "reason", "detail", "bounce_type", "source", "source_message_id", "created_at"] as const;
export const suppressionShape = defineShape({ resource: "suppression", keys: SUPPRESSION_KEYS, defaults: SUPPRESSION_KEYS, expansions: {} });

const LIST_KEYS = ["id", "domain_id", "name", "double_opt_in", "created_at", "updated_at"] as const;
export const listShape = defineShape({
  resource: "list",
  keys: [...LIST_KEYS, "member_counts"],
  defaults: LIST_KEYS,
  expansions: { member_counts: { keys: ["member_counts"], description: "members by status: pending, subscribed and unsubscribed" } },
});

const MEMBERSHIP_KEYS = [
  "id",
  "list_id",
  "address",
  "status",
  "source",
  "source_message_id",
  "manual_actor",
  "attributes",
  "double_opt_in",
  "confirmed_at",
  "confirmed_by",
  "pending_expires_at",
  "unsubscribed_at",
  "created_at",
  "updated_at",
] as const;
export const listMemberShape = defineShape({ resource: "list member", keys: MEMBERSHIP_KEYS, defaults: MEMBERSHIP_KEYS, expansions: {} });

const ADDRESS_KEYS = [
  "id",
  "address",
  "domain_id",
  "local_part",
  "label",
  "status",
  "expires_at",
  "message_cap",
  "key_id",
  "counts",
  "last_received_at",
  "revoked_at",
  "created_at",
  "updated_at",
] as const;
export const addressShape = defineShape({ resource: "address", keys: ADDRESS_KEYS, defaults: ADDRESS_KEYS, expansions: {} });

const FORWARD_TARGET_KEYS = [
  "id",
  "address_id",
  "email",
  "status",
  "confirmation_sent_at",
  "confirmation_expires_at",
  "confirmed_at",
  "disabled_at",
  "disabled_reason",
  "forwarded_count",
  "last_forwarded_at",
  "last_failure",
  "created_at",
  "updated_at",
] as const;
export const forwardTargetShape = defineShape({ resource: "forward target", keys: FORWARD_TARGET_KEYS, defaults: FORWARD_TARGET_KEYS, expansions: {} });

const ACTIVITY_KEYS = ["id", "action", "family", "outcome", "actor", "applies_to", "subject_label", "address", "metadata", "created_at"] as const;
export const activityShape = defineShape({ resource: "activity", keys: ACTIVITY_KEYS, defaults: ACTIVITY_KEYS, expansions: {} });

const DELIVERY_KEYS = [
  "id",
  "endpoint_id",
  "event_type",
  "status",
  "attempt_count",
  "last_status_code",
  "last_error",
  "next_attempt_at",
  "succeeded_at",
  "expires_at",
  "message_id",
  "created_at",
] as const;
const DELIVERY_EXPANSIONS = {
  payload: { keys: ["payload"], description: "the body that was posted, frozen at enqueue" },
  attempts: { keys: ["attempts"], description: "each attempt's status code or error and duration, oldest first" },
} as const;

/** `GET /v1/webhook_endpoints/:id/deliveries`. */
export const webhookDeliveryShape = defineShape({
  resource: "webhook delivery",
  keys: [...DELIVERY_KEYS, "payload", "attempts"],
  defaults: DELIVERY_KEYS,
  expansions: DELIVERY_EXPANSIONS,
});

/** `GET /v1/webhook_endpoints/:id/deliveries/:deliveryId`: the list's shape with both expansions in the default. */
export const webhookDeliveryReadShape = defineShape({
  resource: "webhook delivery",
  keys: [...DELIVERY_KEYS, "payload", "attempts"],
  defaults: [...DELIVERY_KEYS, "payload", "attempts"],
  expansions: DELIVERY_EXPANSIONS,
});

const EXPORT_KEYS =["id", "kind", "status", "count", "filename", "download_url", "error", "requested_at", "started_at", "ready_at", "failed_at", "expires_at"] as const;
export const exportShape = defineShape({ resource: "export", keys: EXPORT_KEYS, defaults: EXPORT_KEYS, expansions: {} });

const BATCH_KEYS = ["id", "domain_id", "list_id", "from", "subject", "tags", "recipient_count", "skipped_count", "counts", "created_at"] as const;
export const batchShape = defineShape({
  resource: "batch",
  keys: BATCH_KEYS,
  defaults: BATCH_KEYS,
  expansions: { counts: { keys: ["counts"], description: "the batch's messages tallied by status" } },
});

const PROVIDER_KEYS = ["id", "adapter", "name", "assigned", "status", "backoff_until", "created_at", "updated_at"] as const;
export const providerShape = defineShape({
  resource: "provider",
  keys: PROVIDER_KEYS,
  defaults: PROVIDER_KEYS,
  expansions: { status: { keys: ["status"], description: "from the provider's health record and its domains" } },
});

const ORGANIZATION_KEYS = [
  "id",
  "name",
  "slug",
  "body_retention_days",
  "body_retention_max_days",
  "address_limit",
  "address_daily_message_limit",
  "suspended",
  "created_at",
  "updated_at",
] as const;
export const organizationShape = defineShape({
  resource: "organization",
  keys: [...ORGANIZATION_KEYS, "address_counts"],
  defaults: ORGANIZATION_KEYS,
  expansions: { address_counts: { keys: ["address_counts"], description: "addresses by status: active, expired and revoked, counted on read" } },
});

const ADMIN_PROVIDER_KEYS = [
  "id",
  "adapter",
  "name",
  "kind",
  "organization_id",
  "organization_count",
  "default_for_new_organizations",
  "identity",
  "settings",
  "concurrency",
  "backoff_until",
  "status",
  "issues",
  "health",
  "conversion",
  "created_at",
  "updated_at",
] as const;
export const adminProviderShape = defineShape({
  resource: "provider",
  keys: ADMIN_PROVIDER_KEYS,
  defaults: ADMIN_PROVIDER_KEYS,
  expansions: { health: { keys: ["status", "issues", "health"], description: "from the health record and quota reads" } },
});

const ASSIGNMENT_KEYS = ["organization_id", "organization_name", "provider_id", "default", "domain_count", "status", "created_at"] as const;
export const assignmentShape = defineShape({
  resource: "assignment",
  idKey: "provider_id",
  keys: ASSIGNMENT_KEYS,
  defaults: ASSIGNMENT_KEYS,
  expansions: {},
});

const ADMIN_ORGANIZATION_KEYS = [
  "id",
  "name",
  "slug",
  "provider_id",
  "managed_provider_id",
  "assignment_count",
  "domain_count",
  "suspension",
  "address_limit",
  "address_daily_message_limit",
  "address_limit_override",
  "address_daily_message_limit_override",
  "created_at",
  "updated_at",
] as const;
export const adminOrganizationShape = defineShape({
  resource: "organization",
  keys: ADMIN_ORGANIZATION_KEYS,
  defaults: ADMIN_ORGANIZATION_KEYS,
  expansions: { counts: { keys: ["assignment_count", "domain_count"], description: "provider assignments and domains, counted" } },
});

const ACCOUNT_KEYS = ["id", "name", "email", "admin", "memberships", "created_at"] as const;
export const accountShape = defineShape({
  resource: "account",
  keys: ACCOUNT_KEYS,
  defaults: ACCOUNT_KEYS,
  expansions: { memberships: { keys: ["memberships"], description: "each organization the account belongs to, and its role" } },
});

const MEMBER_KEYS = ["user_id", "name", "email", "role", "admin", "created_at"] as const;
export const memberShape = defineShape({ resource: "member", idKey: "user_id", keys: MEMBER_KEYS, defaults: MEMBER_KEYS, expansions: {} });

const INVITATION_KEYS = ["id", "email", "role", "status", "invited_by", "expires_at", "accepted_at", "created_at"] as const;
export const invitationShape = defineShape({ resource: "invitation", keys: INVITATION_KEYS, defaults: INVITATION_KEYS, expansions: {} });

const RECIPIENT_KEYS = [
  "address",
  "first_seen_at",
  "last_sent_at",
  "last_status",
  "domain_ids",
  "messages",
  "bounce_count",
  "complaint_count",
  "last_delivered_at",
  "last_bounced_at",
  "last_complained_at",
  "suppression",
  "unsubscribes",
] as const;
export const recipientShape = defineShape({
  resource: "recipient",
  idKey: "address",
  keys: [...RECIPIENT_KEYS, "history", "incidents"],
  defaults: RECIPIENT_KEYS,
  expansions: {
    history: { keys: ["history", "incidents"], description: "the latest 50 messages to the address, and the latest 50 that bounced or complained" },
  },
});
