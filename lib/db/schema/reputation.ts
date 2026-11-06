import { check, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { STANDINGS, type Standing } from "@/lib/reputation/standing";
import { organizations } from "./organizations";
import { domains } from "./domains";
import { providers } from "./providers";
import { enumCheck, nullableEnumCheck } from "./checks";

export const REPUTATION_SUBJECTS = ["domain", "organization"] as const;
export type ReputationSubject = (typeof REPUTATION_SUBJECTS)[number];

/**
 * The last standing the worker acted on, per domain and organization. The dashboard computes
 * standing on read; this only exists so a change fires once and repeat emails can be throttled.
 */
export const reputationStates = pgTable(
  "reputation_states",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<ReputationSubject>().notNull(),
    /** A domain id or the organization's own id. */
    subjectId: text("subject_id").notNull(),
    standing: text("standing").$type<Standing>().notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
    /** The worst standing owners were last emailed about, and when. Null after a release. */
    alertedStanding: text("alerted_standing").$type<Standing | null>(),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.subjectType, table.subjectId] }),
    index("reputation_states_organization_idx").on(table.organizationId),
    check("reputation_states_subject_type_check", enumCheck(table.subjectType, REPUTATION_SUBJECTS)),
    check("reputation_states_standing_check", enumCheck(table.standing, STANDINGS)),
    check("reputation_states_alerted_standing_check", nullableEnumCheck(table.alertedStanding, STANDINGS)),
  ],
);

export type ReputationStateRow = typeof reputationStates.$inferSelect;

/** Sends refused at the API because a recipient is suppressed, per domain per hour. */
export const suppressedRejections = pgTable(
  "suppressed_rejections",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.domainId, table.hour] }),
    index("suppressed_rejections_organization_hour_idx").on(table.organizationId, table.hour),
  ],
);

/** Reputation findings a provider opened on an organization's tenant, until it closes them. */
export const providerFindings = pgTable(
  "provider_findings",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    /** The provider's finding type, such as `BOUNCE`. One open finding per type. */
    type: text("type").notNull(),
    impact: text("impact"),
    description: text("description"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.providerId, table.type] }),
    index("provider_findings_organization_idx").on(table.organizationId),
  ],
);
