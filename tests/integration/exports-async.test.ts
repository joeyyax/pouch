/**
 * The async export path #60 adds on top of #152's synchronous one: a row in `exports` that
 * queues past the size ceiling instead of refusing, a worker job that builds the artifact and
 * a signed URL it can be fetched from, and `/v1/exports` so a caller can drive the whole thing
 * without a browser.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, exportJobs } from "@/lib/db/schema";
import type { ExportKind } from "@/lib/db/schema/exports";
import type { MessageStatus } from "@/lib/db/schema";
import { userActor } from "@/lib/activity/record";
import { newMessageKey } from "@/lib/crypto";
import { newStorageKey, writeBody } from "@/lib/storage/bodies";
import { decideExport, queueExport, type FilteredExportKind } from "@/lib/exports/create";
import { EXPORT_MAX_MESSAGES } from "@/lib/exports/limits";
import { createExportRecord, exportRecordFor } from "@/lib/exports/records";
import { serializeExport } from "@/lib/exports/serialize";
import { GET as getExport, POST as createExport } from "@/app/api/v1/exports/route";
import { GET as readExport } from "@/app/api/v1/exports/[id]/route";
import { ExportLoop } from "@/worker/exports";
import { randomBytes } from "node:crypto";
import { CreateMultipartUploadCommand, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";
import { EXPORT_MAX_ATTEMPTS } from "@/lib/exports/limits";
import { exportsRoot, newExportObjectKey } from "@/lib/exports/artifact-key";
import { EXPORT_FAILED_MESSAGE, EXPORT_LOCK_TIMEOUT_MS } from "@/worker/exports";
import { storage, storageBucket } from "@/lib/storage";
import { MIN_PART_BYTES } from "@/lib/storage/stream";
import { dbNow } from "@/lib/db/clock";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { addDomainKey, addSuppression, resetDatabase, routeContext, seedFixture, seedMessage, type Fixture } from "./fixtures";

/** Counts the bytes a bodies export produces, and lets a test pause the build mid-stream. */
const bodiesProbe = vi.hoisted(() => ({
  onChunk: null as null | ((bytes: number) => Promise<void> | void),
}));

vi.mock("@/lib/exports/bodies", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/exports/bodies")>();
  return {
    ...actual,
    bodiesZipChunks: async function* (...args: Parameters<typeof actual.bodiesZipChunks>) {
      for await (const chunk of actual.bodiesZipChunks(...args)) {
        await bodiesProbe.onChunk?.(chunk.byteLength);
        yield chunk;
      }
    },
  };
});

async function insertMessage(fixture: Fixture, overrides: Partial<{ status: MessageStatus; storageKey: string | null; bodyKey: string | null; bodyPurgedAt: Date | null; subject: string }> = {}): Promise<string> {
  return seedMessage(fixture, {
    status: overrides.status ?? "delivered",
    fromName: "Scope",
    subject: overrides.subject ?? "Async export fixture",
    storageKey: overrides.storageKey ?? null,
    bodyKey: overrides.bodyKey ?? null,
    bodyPurgedAt: overrides.bodyPurgedAt ?? null,
  });
}

function loop(options: Partial<ConstructorParameters<typeof ExportLoop>[0]> = {}): ExportLoop {
  return new ExportLoop({ workerId: "test-worker", intervalMs: 60_000, batchSize: 10, expireBatchSize: 10, ...options });
}

async function insertMessageWithBody(fixture: Fixture, attachmentBytes: number): Promise<string> {
  const storageKey = newStorageKey();
  const { key, encoded } = newMessageKey();
  await writeBody(key, storageKey, {
    html: "<p>hello</p>",
    text: "hello",
    textGenerated: false,
    attachments: [
      { filename: "big.bin", contentType: "application/octet-stream", content: randomBytes(attachmentBytes).toString("base64") },
    ],
  });
  return insertMessage(fixture, { storageKey, bodyKey: encoded });
}

async function exportRow(id: string) {
  const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, id));
  return row!;
}

function apiRequest(secret: string, path: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost/v1/exports${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let fixture: Fixture;

beforeEach(async () => {
  bodiesProbe.onChunk = null;
  await resetDatabase();
  resetRateLimitMemory();
  // Unscoped: several tests below export kind "data", which requires a key with no domain
  // scope — the same rule POST /v1/domains enforces. See "a domain-scoped key can't export
  // organization-wide data" for the scoped case, on its own fixture.
  fixture = await seedFixture({ scopeToDomain: false });
});

describe("decideExport — the sync/async split", () => {
  it("queues instead of refusing past the ceiling", async () => {
    const decision = await decideExport({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "log_csv",
      filters: {},
      count: EXPORT_MAX_MESSAGES + 1,
    });

    expect(decision.queued).toBe(true);
    if (!decision.queued) throw new Error("expected queued");
    expect(decision.record.status).toBe("requested");
    expect(decision.record.count).toBe(EXPORT_MAX_MESSAGES + 1);

    const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, decision.record.id));
    expect(row?.organizationId).toBe(fixture.organizationId);
  });

  it("records no export activity when the export row can't be written", async () => {
    // A kind the table's check constraint refuses makes the insert fail.
    const kind = "not_a_kind";
    await expect(
      queueExport({ organizationId: fixture.organizationId, actor: userActor("u_1", "Test"), kind: kind as ExportKind, count: 1 }),
    ).rejects.toThrow();
    await expect(
      decideExport({
        organizationId: fixture.organizationId,
        actor: userActor("u_1", "Test"),
        kind: kind as FilteredExportKind,
        filters: {},
        count: EXPORT_MAX_MESSAGES + 1,
      }),
    ).rejects.toThrow();

    const rows = await db.select().from(activity).where(eq(activity.organizationId, fixture.organizationId));
    expect(rows.filter((row) => row.action === "system.export.created")).toHaveLength(0);
  });

  it("stays synchronous at or under the ceiling — nothing written to exports", async () => {
    const decision = await decideExport({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "log_csv",
      filters: {},
      count: EXPORT_MAX_MESSAGES,
    });

    expect(decision.queued).toBe(false);
    const rows = await db.select().from(exportJobs).where(eq(exportJobs.organizationId, fixture.organizationId));
    expect(rows).toHaveLength(0);
  });
});

describe("worker/exports.ts — building a queued export", () => {
  it("builds a log_csv artifact and marks the row ready with a download link that resolves", async () => {
    await insertMessage(fixture, { status: "delivered" });
    await insertMessage(fixture, { status: "bounced" });

    const record = await createExportRecord({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "log_csv",
      filters: {},
      count: 2,
    });

    const { processed } = await loop().tick();
    expect(processed).toBe(1);

    const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, record.id));
    expect(row?.status).toBe("ready");
    expect(row?.objectKey).toBeTruthy();
    expect(row?.sizeBytes).toBeGreaterThan(0);
    expect(row?.expiresAt).not.toBeNull();

    const serialized = await serializeExport(row!);
    expect(serialized.download_url).toBeTruthy();

    const response = await fetch(serialized.download_url!);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.split("\r\n")[0]).toContain("id,status,from");
    expect(text.split("\r\n").length).toBeGreaterThanOrEqual(3); // header + 2 rows
  });

  it("still marks a body past retention with why, inside an async bodies export", async () => {
    const storageKey = newStorageKey();
    const { key } = newMessageKey();
    await writeBody(key, storageKey, {
      html: "<p>a secret only the recipient should ever read</p>",
      text: "a secret",
      textGenerated: false,
      attachments: [],
    });
    await insertMessage(fixture, { storageKey, bodyKey: null, bodyPurgedAt: new Date("2026-01-01T00:00:00Z") });

    const record = await createExportRecord({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "bodies",
      filters: {},
      count: 1,
    });

    await loop().tick();
    const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, record.id));
    expect(row?.status).toBe("ready");

    const serialized = await serializeExport(row!);
    const response = await fetch(serialized.download_url!);
    const buffer = Buffer.from(await response.arrayBuffer());

    expect(buffer.toString("latin1")).toContain("X-Pouch-Body-Status: shredded");
    expect(buffer.toString("latin1")).not.toContain("a secret only the recipient should ever read");
  });

  it("marks a row failed with a plain reason, not the storage error, when the upload throws", async () => {
    const record = await createExportRecord({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "data",
      count: 0,
    });

    const bucket = process.env.STORAGE_BUCKET;
    process.env.STORAGE_BUCKET = "pouch-test-missing-bucket";
    try {
      await loop().tick();
    } finally {
      process.env.STORAGE_BUCKET = bucket;
    }

    const row = await exportRow(record.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe(EXPORT_FAILED_MESSAGE);
    expect(row.lockedAt).toBeNull();
    expect(row.objectKey).toBeNull();
  });
});

describe("streaming the artifact to storage", () => {
  const COUNTER = "countExportUploadBytes";
  let uploaded = 0;

  beforeEach(() => {
    uploaded = 0;
    storage().middlewareStack.remove(COUNTER);
    storage().middlewareStack.add(
      (next, context) => async (args) => {
        const result = await next(args);
        const input = args.input as { Key?: string; Body?: unknown };
        const counted = context.commandName === "UploadPartCommand" || context.commandName === "PutObjectCommand";
        if (counted && input.Key?.startsWith(exportsRoot()) && input.Body instanceof Uint8Array) {
          uploaded += input.Body.byteLength;
        }
        return result;
      },
      { step: "initialize", name: COUNTER },
    );
  });
  afterAll(() => {
    storage().middlewareStack.remove(COUNTER);
  });

  it("holds about one part in memory while building an artifact many parts long", async () => {
    const partBytes = MIN_PART_BYTES;
    const messageCount = 8;
    for (let i = 0; i < messageCount; i++) await insertMessageWithBody(fixture, 4 * 1024 * 1024);

    const record = await createExportRecord({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "bodies",
      filters: {},
      count: messageCount,
    });

    let produced = 0;
    let largestChunk = 0;
    let peakHeld = 0;
    bodiesProbe.onChunk = (bytes) => {
      produced += bytes;
      largestChunk = Math.max(largestChunk, bytes);
      peakHeld = Math.max(peakHeld, produced - uploaded);
    };

    await loop({ partBytes }).tick();

    const row = await exportRow(record.id);
    expect(row.status).toBe("ready");
    expect(row.sizeBytes).toBe(produced);
    expect(uploaded).toBe(produced);
    expect(produced).toBeGreaterThan(6 * partBytes);
    // Bytes produced but not yet acknowledged by storage never pass one part plus one entry.
    expect(peakHeld).toBeLessThanOrEqual(partBytes + largestChunk);

    const download = Buffer.from(await (await fetch((await serializeExport(row)).download_url!)).arrayBuffer());
    expect(download.byteLength).toBe(produced);
    const end = download.subarray(download.byteLength - 22);
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(10)).toBe(messageCount);
  });

  it("fails the job with a clear reason once the artifact passes the byte cap", async () => {
    for (let i = 0; i < 20; i++) await insertMessage(fixture, { subject: `Row ${i} ${"x".repeat(80)}` });

    const record = await createExportRecord({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "log_csv",
      filters: {},
      count: 20,
    });

    await loop({ maxArtifactBytes: 1024 }).tick();

    const row = await exportRow(record.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("This export passed 1 KB, the most one export can hold. Narrow the filter and request it again.");
    expect(row.objectKey).toBeNull();
    expect(uploaded).toBe(0);
  });
});

describe("isolation — one organization never sees another's export", () => {
  it("reads as not_found across organizations, by id", async () => {
    const other = await seedFixture();
    const record = await createExportRecord({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "data",
      count: 0,
    });

    expect(await exportRecordFor(other.organizationId, record.id)).toBeNull();
    expect(await exportRecordFor(fixture.organizationId, record.id)).not.toBeNull();
  });

  it("the /v1 route answers not_found for another organization's key", async () => {
    const other = await seedFixture();
    const record = await createExportRecord({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "data",
      count: 0,
    });

    const response = await readExport(apiRequest(other.secret, `/${record.id}`, "GET"), routeContext(record.id));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });
});

describe("/v1/exports — pollable without a browser", () => {
  it("POST always queues and returns 202 with a poll id", async () => {
    await addSuppression(fixture.organizationId, "bounced@example.com");

    const response = await createExport(apiRequest(fixture.secret, "", "POST", { kind: "data" }));
    expect(response.status).toBe(202);
    const body = (await response.json()) as { id: string; status: string };
    expect(body.id).toMatch(/^exp_/);
    expect(body.status).toBe("requested");
    expect(response.headers.get("location")).toContain(`/v1/exports/${body.id}`);
  });

  it("GET /v1/exports/:id reflects the worker's progress, ending with a working download link", async () => {
    const created = await createExport(apiRequest(fixture.secret, "", "POST", { kind: "data" }));
    const { id } = (await created.json()) as { id: string };

    const beforeResponse = await readExport(apiRequest(fixture.secret, `/${id}`, "GET"), routeContext(id));
    const before = (await beforeResponse.json()) as { status: string; download_url: string | null };
    expect(before.status).toBe("requested");
    expect(before.download_url).toBeNull();

    await loop().tick();

    const afterResponse = await readExport(apiRequest(fixture.secret, `/${id}`, "GET"), routeContext(id));
    const after = (await afterResponse.json()) as { status: string; download_url: string | null };
    expect(after.status).toBe("ready");
    expect(after.download_url).toBeTruthy();

    const download = await fetch(after.download_url!);
    expect(download.status).toBe(200);
  });

  it("a domain-scoped key can't export organization-wide data", async () => {
    const scoped = await seedFixture({ scopeToDomain: true });
    const response = await createExport(apiRequest(scoped.secret, "", "POST", { kind: "data" }));
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("key_not_scoped");
  });

  it("shows a domain-scoped key only message exports held inside its domains", async () => {
    const scoped = await addDomainKey(fixture);
    const actor = userActor("u", "Me");
    const inScope = await createExportRecord({ organizationId: fixture.organizationId, actor, kind: "log_csv", filters: { restrictToDomainIds: [scoped.domainId] }, count: 0 });
    const hidden = [
      await createExportRecord({ organizationId: fixture.organizationId, actor, kind: "data", count: 0 }),
      await createExportRecord({ organizationId: fixture.organizationId, actor, kind: "bodies", filters: {}, count: 0 }),
      await createExportRecord({ organizationId: fixture.organizationId, actor, kind: "log_csv", filters: { restrictToDomainIds: [fixture.domainId, scoped.domainId] }, count: 0 }),
    ];

    const response = await getExport(apiRequest(scoped.secret, "", "GET"));
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.map((row) => row.id)).toEqual([inScope.id]);

    for (const row of hidden) {
      const read = await readExport(apiRequest(scoped.secret, `/${row.id}`, "GET"), routeContext(row.id));
      expect(read.status).toBe(404);
    }
    expect((await readExport(apiRequest(scoped.secret, `/${inScope.id}`, "GET"), routeContext(inScope.id))).status).toBe(200);
  });

  it("GET /v1/exports lists newest first, scoped to the key's organization", async () => {
    const other = await seedFixture();
    await createExportRecord({ organizationId: other.organizationId, actor: userActor("u", "Other"), kind: "data", count: 0 });
    const mine = await createExportRecord({ organizationId: fixture.organizationId, actor: userActor("u", "Me"), kind: "data", count: 0 });

    const response = await getExport(apiRequest(fixture.secret, "", "GET"));
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.map((row) => row.id)).toEqual([mine.id]);
  });
});

describe("a job that keeps failing", () => {
  it("is failed after its last attempt and not claimed again", async () => {
    const row = await createExportRecord({
      organizationId: fixture.organizationId,
      kind: "log_csv",
      actor: userActor("user_1", "Ada"),
      filters: {},
      count: 1,
    });

    // As a worker that died mid-build on its last attempt leaves it.
    const now = await dbNow();
    await db
      .update(exportJobs)
      .set({
        attempts: EXPORT_MAX_ATTEMPTS,
        status: "running",
        lockedBy: "dead-worker",
        lockedAt: new Date(now.getTime() - EXPORT_LOCK_TIMEOUT_MS - 60_000),
      })
      .where(eq(exportJobs.id, row.id));

    expect((await loop().tick()).processed).toBe(0);

    const after = await exportRow(row.id);
    expect(after.status).toBe("failed");
    expect(after.error).toBe(
      `This export stopped ${EXPORT_MAX_ATTEMPTS} times without finishing, so it won't be tried again. Narrow the filter and request it again.`,
    );
    expect(after.lockedAt).toBeNull();
    expect(after.attempts).toBe(EXPORT_MAX_ATTEMPTS + 1);

    expect((await loop().tick()).processed).toBe(0);
    const later = await exportRow(row.id);
    expect(later.status).toBe("failed");
    expect(later.attempts).toBe(EXPORT_MAX_ATTEMPTS + 1);
  });

  it("aborts the upload a crashed attempt left behind when it reclaims the row", async () => {
    const row = await createExportRecord({
      organizationId: fixture.organizationId,
      kind: "data",
      actor: userActor("user_1", "Ada"),
      count: 0,
    });

    const staleKey = newExportObjectKey();
    const created = await storage().send(
      new CreateMultipartUploadCommand({ Bucket: storageBucket(), Key: staleKey, ContentType: "text/plain" }),
    );
    const now = await dbNow();
    await db
      .update(exportJobs)
      .set({
        attempts: 1,
        status: "running",
        lockedBy: "dead-worker",
        lockedAt: new Date(now.getTime() - EXPORT_LOCK_TIMEOUT_MS - 60_000),
        objectKey: staleKey,
        uploadId: created.UploadId,
      })
      .where(eq(exportJobs.id, row.id));

    await loop().tick();

    const after = await exportRow(row.id);
    expect(after.status).toBe("ready");
    expect(after.objectKey).not.toBe(staleKey);
    expect(after.uploadId).toBeNull();
    const uploads = await storage().send(new ListMultipartUploadsCommand({ Bucket: storageBucket(), Prefix: staleKey }));
    expect(uploads.Uploads ?? []).toHaveLength(0);
  });

  it("gives the claim back on a clean shutdown instead of spending an attempt", async () => {
    await insertMessageWithBody(fixture, 1024);
    await insertMessageWithBody(fixture, 1024);
    const record = await createExportRecord({
      organizationId: fixture.organizationId,
      actor: userActor("u_1", "Test"),
      kind: "bodies",
      filters: {},
      count: 2,
    });

    let started!: () => void;
    const building = new Promise<void>((resolve) => (started = resolve));
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));
    bodiesProbe.onChunk = async () => {
      started();
      await paused;
    };

    const worker = loop();
    const tick = worker.tick();
    await building;
    const stopping = worker.stop();
    resume();
    await stopping;
    await tick;

    const row = await exportRow(record.id);
    expect(row.status).toBe("requested");
    expect(row.attempts).toBe(0);
    expect(row.lockedBy).toBeNull();
    expect(row.objectKey).toBeNull();

    bodiesProbe.onChunk = null;
    await loop().tick();
    const rebuilt = await exportRow(record.id);
    expect(rebuilt.status).toBe("ready");
    expect(rebuilt.attempts).toBe(1);
  });
});
