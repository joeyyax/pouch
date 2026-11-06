import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./organizations";
import { enumCheck, nullableEnumCheck } from "./checks";

export const API_KEY_MODES = ["live", "test"] as const;
export type ApiKeyMode = (typeof API_KEY_MODES)[number];

/** `admin` keys belong to the service, not an organization, and reach `/v1/admin/*`. */
export const API_KEY_SCOPES = ["organization", "admin"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_REVOKED_REASONS = ["creator_demoted", "creator_deleted"] as const;
export type ApiKeyRevokedReason = (typeof API_KEY_REVOKED_REASONS)[number];

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    /** Null means the key belongs to the service. Admin keys have none. */
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** SHA-256 of the full secret. The secret is shown once and never stored. */
    secretHash: text("secret_hash").notNull().unique(),
    /** Leading characters of the secret, for display in the dashboard. */
    secretPrefix: text("secret_prefix").notNull(),
    /** Test-mode keys route every send to the mock provider. */
    mode: text("mode").$type<ApiKeyMode>().notNull().default("live"),
    /** Domain ids this key can send from. Empty means every domain in the organization. */
    domainIds: text("domain_ids").array().notNull().default([]),
    /**
     * Requests allowed per minute. This paces ingress, not the provider: what protects a
     * downstream provider is `providers.concurrency` and its backoff on a 429.
     */
    rateLimit: integer("rate_limit").notNull().default(3000),
    scope: text("scope").$type<ApiKeyScope>().notNull().default("organization"),
    /** An admin key stops working once this user isn't an admin. */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Set when the key was revoked for its creator, not by a person. */
    revokedReason: text("revoked_reason").$type<ApiKeyRevokedReason>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("api_keys_organization_idx").on(table.organizationId),
    index("api_keys_created_by_idx").on(table.createdBy),
    check("api_keys_mode_check", enumCheck(table.mode, API_KEY_MODES)),
    check("api_keys_scope_check", enumCheck(table.scope, API_KEY_SCOPES)),
    check("api_keys_revoked_reason_check", nullableEnumCheck(table.revokedReason, API_KEY_REVOKED_REASONS)),
    check(
      "api_keys_admin_scope_check",
      sql`${table.scope} <> 'admin' or (cardinality(${table.domainIds}) = 0 and ${table.mode} = 'live')`,
    ),
    check("api_keys_organization_check", sql`(${table.scope} = 'admin') = (${table.organizationId} is null)`),
  ],
);
