import { check, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { enumCheck } from "./checks";

/**
 * Append-only record of who changed what in an organization's provider. Not a
 * debug log — request traces and exceptions go to logging and error
 * reporting. This answers "who did this and when" for a person reading the
 * dashboard.
 *
 * `family` and `outcome` are written at insert time (see lib/activity/taxonomy.ts)
 * and indexed, so a filter is a predicate the database answers rather than a
 * scan. `applies_to` holds the subject's id with no matching type column — the
 * action prefix implies it. `subject_label` and `actor_label` are snapshots
 * taken at write time so a row stays legible after the thing or the actor is
 * gone, without a join back to a row that may no longer exist.
 *
 * No update path exists in application code. Each action declares its retention in the taxonomy
 * and the worker's activity-retention loop deletes past it; an action that declares none is kept.
 */

export const ACTIVITY_ACTOR_TYPES = ["user", "admin", "api_key", "worker", "provider"] as const;
export type ActivityActorType = (typeof ACTIVITY_ACTOR_TYPES)[number];

export const ACTIVITY_FAMILIES = [
  "key",
  "domain",
  "suppression",
  "settings",
  "webhook",
  "provider",
  "session",
  "system",
  "list",
] as const;
export type ActivityFamily = (typeof ACTIVITY_FAMILIES)[number];

export const ACTIVITY_OUTCOMES = ["success", "failure", "neutral"] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

export const activity = pgTable(
  "activity",
  {
    id: text("id").primaryKey(),
    /** Null for a service-level write, which belongs to no organization. */
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    family: text("family").$type<ActivityFamily>().notNull(),
    outcome: text("outcome").$type<ActivityOutcome>().notNull(),
    /** Who did it. `system` (actorType "worker") is a first-class value, not a null user id.
     * `admin` is a person acting on the service's authority, not the organization's. */
    actorType: text("actor_type").$type<ActivityActorType>().notNull(),
    /** User id, API key id or provider id. Null for the worker. */
    actorId: text("actor_id"),
    /** Name or descriptive label at write time — the row reads the same after the actor is gone. */
    actorLabel: text("actor_label").notNull(),
    /** The subject's id. Its type is implied by the action's prefix, so there's no type column. */
    appliesTo: text("applies_to"),
    /** The subject's name at write time, for the row that outlives it. */
    subjectLabel: text("subject_label"),
    /** Keyed hash of the client address (lib/api/client-ip.ts), never the address. Only for actions whose taxonomy entry allows it. */
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    /** Before/after values, reasons, error strings. Resist a column per fact. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Row id as tiebreaker: two rows sharing a millisecond don't shadow each other
    // across a cursor page boundary.
    index("activity_org_created_at_idx").on(table.organizationId, table.createdAt, table.id),
    index("activity_org_family_created_at_idx").on(table.organizationId, table.family, table.createdAt),
    index("activity_org_outcome_created_at_idx").on(table.organizationId, table.outcome, table.createdAt),
    index("activity_org_applies_to_idx").on(table.organizationId, table.appliesTo),
    index("activity_action_created_at_idx").on(table.action, table.createdAt),
    index("activity_org_actor_idx").on(table.organizationId, table.actorType, table.actorId),
    check("activity_family_check", enumCheck(table.family, ACTIVITY_FAMILIES)),
    check("activity_outcome_check", enumCheck(table.outcome, ACTIVITY_OUTCOMES)),
    check("activity_actor_type_check", enumCheck(table.actorType, ACTIVITY_ACTOR_TYPES)),
  ],
);
