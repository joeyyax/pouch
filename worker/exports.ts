import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { exportJobs, type ExportJobRow } from "@/lib/db/schema/exports";
import { reviveFilters } from "@/lib/messages/filters";
import { recordJobBeat } from "@/lib/health";
import { newExportObjectKey } from "@/lib/exports/artifact-key";
import { bodiesZipChunks } from "@/lib/exports/bodies";
import { organizationDataNdjsonLines } from "@/lib/exports/data";
import { exportFilename } from "@/lib/wire";
import { ExportRefusedError } from "@/lib/exports/errors";
import {
  EXPORT_ARTIFACT_TTL_DAYS,
  EXPORT_MAX_ARTIFACT_BYTES,
  EXPORT_MAX_ATTEMPTS,
  EXPORT_MAX_ZIP_ENTRIES,
} from "@/lib/exports/limits";
import { messagesCsvLines, messagesNdjsonLines } from "@/lib/exports/log";
import { deleteObject } from "@/lib/storage";
import { abortUpload, DEFAULT_PART_BYTES, uploadStream } from "@/lib/storage/stream";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { formatNumber } from "@/lib/format/number";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("worker:exports");

/** Longest a claimed row may go without a lease renewal before another worker may reclaim it. */
export const EXPORT_LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/** How often a running build renews its lock and the loop heartbeat. Under the heartbeat's 15 s window. */
export const EXPORT_LEASE_RENEW_MS = 10_000;

export const EXPORT_FAILED_MESSAGE = "This export couldn't be built. Request it again.";

export interface ExportLoopOptions {
  workerId: string;
  intervalMs: number;
  batchSize: number;
  expireBatchSize: number;
  maxArtifactBytes?: number;
  partBytes?: number;
  leaseRenewMs?: number;
}

type Interruption = "shutdown" | "lost";

interface ArtifactSource {
  source: AsyncGenerator<string | Uint8Array>;
  contentType: string;
  filename: string;
}

/** Converts to bytes and fails the build once it passes the cap. */
async function* capped(source: AsyncGenerator<string | Uint8Array>, maxBytes: number): AsyncGenerator<Uint8Array> {
  let total = 0;
  for await (const chunk of source) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new ExportRefusedError(
        `This export passed ${formatBytes(maxBytes)}, the most one export can hold. Narrow the filter and request it again.`,
      );
    }
    yield bytes;
  }
}

function formatBytes(bytes: number): string {
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value)} ${units[unit]}`;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The same generators a synchronous export streams, so the bytes match. */
function artifactSource(row: ExportJobRow): ArtifactSource {
  const filters = reviveFilters(row.filters);
  switch (row.kind) {
    case "log_csv":
      return {
        source: messagesCsvLines(row.organizationId, filters),
        contentType: "text/csv; charset=utf-8",
        filename: exportFilename("messages", stamp(), "csv"),
      };
    case "log_ndjson":
      return {
        source: messagesNdjsonLines(row.organizationId, filters),
        contentType: "application/x-ndjson; charset=utf-8",
        filename: exportFilename("messages", stamp(), "ndjson"),
      };
    case "bodies":
      if ((row.count ?? 0) > EXPORT_MAX_ZIP_ENTRIES) {
        throw new ExportRefusedError(
          `A bodies export holds at most ${formatNumber(EXPORT_MAX_ZIP_ENTRIES)} messages. Narrow the filter and request it again.`,
        );
      }
      return {
        source: bodiesZipChunks(row.organizationId, filters),
        contentType: "application/zip",
        filename: exportFilename("bodies", stamp(), "zip"),
      };
    case "data":
      return {
        source: organizationDataNdjsonLines(row.organizationId),
        contentType: "application/x-ndjson; charset=utf-8",
        filename: exportFilename("data", stamp(), "ndjson"),
      };
  }
}

/** Removes what an unfinished attempt left in storage. */
async function discardArtifact(objectKey: string | null, uploadId: string | null): Promise<void> {
  if (!objectKey) return;
  if (uploadId) {
    await abortUpload("private", objectKey, uploadId).catch((err) =>
      log.warn(`aborting upload ${uploadId} failed: ${safeErrorMessage(err)}`),
    );
  }
  await deleteObject("private", objectKey).catch((err) =>
    log.warn(`deleting ${objectKey} failed: ${safeErrorMessage(err)}`),
  );
}

/** Builds each queued export's artifact and expires the ones past their TTL. */
export class ExportLoop extends IntervalLoop<{ processed: number; expired: number }> {
  protected readonly name = "export";
  protected readonly log = log;
  protected readonly intervalMs: number;
  protected readonly workerId: string | undefined;
  private building: AbortController | null = null;

  constructor(private readonly options: ExportLoopOptions) {
    super();
    this.intervalMs = options.intervalMs;
    this.workerId = options.workerId;
  }

  protected async run(): Promise<{ processed: number; expired: number }> {
    const processed = await this.processBatch();
    const expired = await this.sweepExpired();
    return { processed, expired };
  }

  /** Aborts the build in flight and gives its claim back. */
  override async stop(): Promise<void> {
    this.building?.abort("shutdown" satisfies Interruption);
    await super.stop();
  }

  private ownRow(id: string) {
    return and(eq(exportJobs.id, id), eq(exportJobs.status, "running"), eq(exportJobs.lockedBy, this.options.workerId));
  }

  /** Claims one requested row, or a running one whose lock went stale (a crashed worker). */
  private async claimOne(): Promise<ExportJobRow | null> {
    const now = await dbNow();
    const staleBefore = new Date(now.getTime() - EXPORT_LOCK_TIMEOUT_MS);

    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ id: exportJobs.id })
        .from(exportJobs)
        .where(
          or(
            eq(exportJobs.status, "requested"),
            and(eq(exportJobs.status, "running"), lt(exportJobs.lockedAt, staleBefore)),
          ),
        )
        .orderBy(asc(exportJobs.requestedAt))
        .limit(1)
        .for("update", { of: exportJobs, skipLocked: true });
      if (!candidate) return null;

      const [claimed] = await tx
        .update(exportJobs)
        .set({
          status: "running",
          startedAt: now,
          lockedAt: now,
          lockedBy: this.options.workerId,
          attempts: sql`${exportJobs.attempts} + 1`,
        })
        .where(eq(exportJobs.id, candidate.id))
        .returning();
      return claimed ?? null;
    });
  }

  private async processBatch(): Promise<number> {
    let processed = 0;
    for (let i = 0; i < this.options.batchSize; i++) {
      if (this.stopped) break;
      const row = await this.claimOne();
      if (!row) break;
      if (row.objectKey || row.uploadId) {
        await discardArtifact(row.objectKey, row.uploadId);
        await db.update(exportJobs).set({ objectKey: null, uploadId: null }).where(this.ownRow(row.id));
      }
      if (row.attempts > EXPORT_MAX_ATTEMPTS) {
        await this.giveUp(row);
        continue;
      }
      await this.process(row);
      processed += 1;
    }
    return processed;
  }

  /** Marks a row failed for good, after it has used every claim it gets. */
  private async giveUp(row: ExportJobRow): Promise<void> {
    const now = await dbNow();
    log.error(`export ${row.id} gave up after ${EXPORT_MAX_ATTEMPTS} attempts`);
    await this.finish(row.id, {
      status: "failed",
      error: `This export stopped ${EXPORT_MAX_ATTEMPTS} times without finishing, so it won't be tried again. Narrow the filter and request it again.`,
      failedAt: now,
    });
  }

  private async finish(id: string, values: Partial<typeof exportJobs.$inferInsert>): Promise<boolean> {
    const updated = await db
      .update(exportJobs)
      .set({ ...values, lockedAt: null, lockedBy: null })
      .where(this.ownRow(id))
      .returning({ id: exportJobs.id });
    return updated.length > 0;
  }

  private async renewLease(id: string, controller: AbortController): Promise<void> {
    try {
      const now = await dbNow();
      const renewed = await db
        .update(exportJobs)
        .set({ lockedAt: now })
        .where(this.ownRow(id))
        .returning({ id: exportJobs.id });
      if (renewed.length === 0) controller.abort("lost" satisfies Interruption);
    } catch (err) {
      log.warn(`renewing export ${id} failed: ${safeErrorMessage(err)}`);
    }
    void recordJobBeat(this.name);
  }

  private async process(row: ExportJobRow): Promise<void> {
    const controller = new AbortController();
    this.building = controller;
    const lease = setInterval(
      () => void this.renewLease(row.id, controller),
      this.options.leaseRenewMs ?? EXPORT_LEASE_RENEW_MS,
    );
    const objectKey = newExportObjectKey();
    let uploadId: string | null = null;

    try {
      const artifact = artifactSource(row);
      await db.update(exportJobs).set({ objectKey }).where(this.ownRow(row.id));
      const { bytes } = await uploadStream(
        "private",
        objectKey,
        capped(artifact.source, this.options.maxArtifactBytes ?? EXPORT_MAX_ARTIFACT_BYTES),
        {
          contentType: artifact.contentType,
          partBytes: this.options.partBytes ?? DEFAULT_PART_BYTES,
          signal: controller.signal,
          onMultipartStarted: async (id) => {
            uploadId = id;
            await db.update(exportJobs).set({ uploadId: id }).where(this.ownRow(row.id));
          },
        },
      );
      controller.signal.throwIfAborted();

      const now = await dbNow();
      const finished = await this.finish(row.id, {
        status: "ready",
        objectKey,
        uploadId: null,
        contentType: artifact.contentType,
        filename: artifact.filename,
        sizeBytes: bytes,
        readyAt: now,
        expiresAt: new Date(now.getTime() + EXPORT_ARTIFACT_TTL_DAYS * 24 * 60 * 60 * 1000),
      });
      if (!finished) {
        await discardArtifact(objectKey, null);
        log.warn(`export ${row.id} was reclaimed before it finished; discarded this copy`);
        return;
      }
      log.info(`export ${row.id} ready: ${bytes} bytes`);
    } catch (err) {
      await discardArtifact(objectKey, uploadId);
      const interruption = controller.signal.aborted ? (controller.signal.reason as Interruption) : null;

      if (interruption === "shutdown") {
        await db
          .update(exportJobs)
          .set({
            status: "requested",
            attempts: sql`greatest(${exportJobs.attempts} - 1, 0)`,
            startedAt: null,
            lockedAt: null,
            lockedBy: null,
            objectKey: null,
            uploadId: null,
          })
          .where(this.ownRow(row.id));
        log.info(`export ${row.id} released for another worker`);
        return;
      }
      if (interruption === "lost") {
        log.warn(`export ${row.id} lost its claim mid-build`);
        return;
      }

      const refused = err instanceof ExportRefusedError;
      log.error(`export ${row.id} failed: ${safeErrorMessage(err)}`);
      await this.finish(row.id, {
        status: "failed",
        error: refused ? err.message : EXPORT_FAILED_MESSAGE,
        failedAt: await dbNow(),
        objectKey: null,
        uploadId: null,
      });
    } finally {
      clearInterval(lease);
      this.building = null;
    }
  }

  /** Deletes the artifact for every ready row past its TTL and marks the row expired. */
  private async sweepExpired(): Promise<number> {
    const now = await dbNow();
    const due = await db
      .select({ id: exportJobs.id, objectKey: exportJobs.objectKey })
      .from(exportJobs)
      .where(and(eq(exportJobs.status, "ready"), lt(exportJobs.expiresAt, now)))
      .orderBy(asc(exportJobs.expiresAt))
      .limit(this.options.expireBatchSize);
    if (due.length === 0) return 0;

    for (const row of due) {
      if (!row.objectKey) continue;
      await deleteObject("private", row.objectKey).catch((err) =>
        log.warn(`delete failed for export ${row.id}: ${safeErrorMessage(err)}`),
      );
    }

    await db
      .update(exportJobs)
      .set({ status: "expired", objectKey: null })
      .where(
        inArray(
          exportJobs.id,
          due.map((row) => row.id),
        ),
      );
    return due.length;
  }
}
