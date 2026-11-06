import { check, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { ACTIVITY_ACTOR_TYPES, type ActivityActorType } from "./activity";
import { enumCheck } from "./checks";

/**
 * An export's data source. Matches lib/exports/audit.ts's ExportKind — the same vocabulary
 * an export is audited under carries through to the row that tracks its async run.
 */
export const EXPORT_KINDS = ["log_csv", "log_ndjson", "bodies", "data"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_STATUSES = ["requested", "running", "ready", "failed", "expired"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/**
 * A queued export: requested past the row ceiling lib/exports/limits.ts draws between a
 * synchronous stream and a worker job. A small export never gets a row here — it still
 * streams straight from the request, unchanged from #152.
 *
 * The artifact is a second, unencrypted copy of whatever a synchronous export would have
 * streamed — a `bodies` export doubly so, since it's decrypted message content. `object_key`
 * points at it in the same private bucket message bodies live in; `expires_at` bounds how
 * long that copy exists. The worker (worker/exports.ts) both produces the artifact and
 * sweeps it past `expires_at`, the same job owning both halves of its lifetime.
 */
export const exportJobs = pgTable(
  "exports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ExportKind>().notNull(),
    status: text("status").$type<ExportStatus>().notNull().default("requested"),
    /** Who asked for it — a dashboard session or an API key, the same actor shape activity uses. */
    actorType: text("actor_type").$type<ActivityActorType>().notNull(),
    actorId: text("actor_id"),
    actorLabel: text("actor_label").notNull(),
    /** The messages-screen filter this export was scoped to, when its kind is filtered. */
    filters: jsonb("filters").$type<Record<string, unknown>>(),
    /** Row count as of the request. Set at creation for log/bodies kinds, at completion for data. */
    count: integer("count"),
    /** Where the finished artifact lives in the private bucket. Null until ready. */
    objectKey: text("object_key"),
    contentType: text("content_type"),
    filename: text("filename"),
    sizeBytes: integer("size_bytes"),
    error: text("error"),
    /** Multipart upload of the attempt in progress, so a reclaim can abort a crashed one's parts. */
    uploadId: text("upload_id"),
    /** Claims spent on this row. A crash spends one; a clean shutdown gives it back. */
    attempts: integer("attempts").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** Past this point the worker deletes the artifact and the row reads expired, not ready. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    index("exports_organization_requested_idx").on(table.organizationId, table.requestedAt),
    index("exports_claim_idx").on(table.status, table.requestedAt),
    index("exports_expiry_idx").on(table.status, table.expiresAt),
    check("exports_kind_check", enumCheck(table.kind, EXPORT_KINDS)),
    check("exports_status_check", enumCheck(table.status, EXPORT_STATUSES)),
    check("exports_actor_type_check", enumCheck(table.actorType, ACTIVITY_ACTOR_TYPES)),
  ],
);

export type ExportJobRow = typeof exportJobs.$inferSelect;
