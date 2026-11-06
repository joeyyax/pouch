/** Seals inbound rows stored before #487; see scripts/seal-inbound.ts. */
import { randomBytes } from "node:crypto";
import { eachBounded } from "@/lib/async";
import { and, asc, eq, gt, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { inboundMessages, type InboundAttachment, type InboundMessageRow } from "@/lib/db/schema";
import { newMessageKey } from "@/lib/crypto";
import { deleteObject, getObjectBytes } from "@/lib/storage";
import { writeSealed } from "@/lib/storage/bodies";
import { newInboundStorageKey, purgeInboundObjects, writeInboundBody } from "./attachments";
import { scrubOrphanedInboundPayloads } from "./payloads";
import { safeErrorMessage } from "@/lib/errors/scrub";

const SEALED_FOLDER = "/sealed-";

export interface SealOptions {
  batchSize?: number;
  concurrency?: number;
  organizationId?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface SealResult {
  sealed: number;
  failed: number;
  /** Stored webhook payloads whose message was already gone, bodies nulled. */
  payloadsScrubbed: number;
  /** Rows the sweep re-deleted plaintext objects for. */
  swept: number;
}

/** A row still holding plaintext somewhere: in its columns or in storage. */
const legacy = and(
  isNull(inboundMessages.bodyKey),
  or(
    isNotNull(inboundMessages.text),
    isNotNull(inboundMessages.html),
    isNotNull(inboundMessages.rawStorageKey),
    sql`jsonb_path_exists(${inboundMessages.attachments}, '$[*] ? (@.storageKey != null)')`,
  ),
);

/** How many rows still hold plaintext. */
export async function countLegacyInbound(organizationId?: string): Promise<number> {
  return (await countLegacyInboundDetail(organizationId)).total;
}

/** The same, split out by rows past retention, which the backfill leaves to the retention sweep. */
export async function countLegacyInboundDetail(organizationId?: string): Promise<{ total: number; expired: number }> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int`, expired: sql<number>`(count(*) filter (where ${inboundMessages.expiresAt} <= now() + interval '1 minute'))::int` })
    .from(inboundMessages)
    .where(and(legacy, organizationId ? eq(inboundMessages.organizationId, organizationId) : undefined));
  return { total: row?.total ?? 0, expired: row?.expired ?? 0 };
}

function parentOf(objectKey: string): string {
  return objectKey.slice(0, objectKey.lastIndexOf("/"));
}

/** The folder a legacy row's objects live in, or null when it has none. */
function legacyPrefix(row: InboundMessageRow): string | null {
  const first = row.rawStorageKey ?? row.attachments.find((attachment) => attachment.storageKey)?.storageKey ?? null;
  return first ? parentOf(first) : null;
}

/** Plaintext objects a sealed-by-backfill row's storage key points back to. */
function plaintextKeys(row: Pick<InboundMessageRow, "storageKey" | "attachments" | "rawStorageKey">): string[] {
  if (!row.storageKey?.includes(SEALED_FOLDER)) return [];
  const prefix = parentOf(row.storageKey);
  return [...row.attachments.map((_, index) => `${prefix}/${index}`), `${prefix}/raw`];
}

/** Writes under a fresh `sealed-` folder, claims the row, then deletes the plaintext. */
async function sealRow(row: InboundMessageRow): Promise<boolean> {
  const { key, encoded } = newMessageKey();
  const prefix = legacyPrefix(row);
  const storageKey = prefix ? `${prefix}${SEALED_FOLDER}${randomBytes(9).toString("base64url")}` : newInboundStorageKey();

  await writeInboundBody(key, storageKey, { text: row.text, html: row.html });
  const attachments: InboundAttachment[] = [];
  for (const [index, attachment] of row.attachments.entries()) {
    if (!attachment.storageKey) {
      attachments.push(attachment);
      continue;
    }
    const sealedKey = `${storageKey}/${index}`;
    await writeSealed(key, sealedKey, await getObjectBytes("private", attachment.storageKey));
    attachments.push({ ...attachment, storageKey: sealedKey });
  }
  let rawStorageKey: string | null = null;
  if (row.rawStorageKey) {
    rawStorageKey = `${storageKey}/raw`;
    await writeSealed(key, rawStorageKey, await getObjectBytes("private", row.rawStorageKey));
  }

  const claimed = await db
    .update(inboundMessages)
    .set({ bodyKey: encoded, storageKey, attachments, rawStorageKey, text: null, html: null })
    .where(and(eq(inboundMessages.id, row.id), isNull(inboundMessages.bodyKey)))
    .returning({ id: inboundMessages.id });

  if (claimed.length === 0) {
    // Purged or sealed by someone else meanwhile: these objects are nobody's.
    await purgeInboundObjects({ attachments, rawStorageKey, storageKey });
    return false;
  }

  const plaintext = [row.rawStorageKey, ...row.attachments.map((attachment) => attachment.storageKey)].filter((k): k is string => k !== null);
  await Promise.all(plaintext.map((objectKey) => deleteObject("private", objectKey)));
  return true;
}


/** Re-deletes the plaintext objects of rows the backfill sealed, for a run that stopped between claim and delete. */
export async function sweepSealedLegacy(
  options: { batchSize?: number; organizationId?: string; log?: (line: string) => void } = {},
): Promise<{ swept: number; failed: number }> {
  const batchSize = options.batchSize ?? 200;
  let after = "";
  let swept = 0;
  let failed = 0;
  for (;;) {
    const rows = await db
      .select({ id: inboundMessages.id, storageKey: inboundMessages.storageKey, attachments: inboundMessages.attachments, rawStorageKey: inboundMessages.rawStorageKey })
      .from(inboundMessages)
      .where(
        and(
          like(inboundMessages.storageKey, `%${SEALED_FOLDER}%`),
          gt(inboundMessages.id, after),
          options.organizationId ? eq(inboundMessages.organizationId, options.organizationId) : undefined,
        ),
      )
      .orderBy(asc(inboundMessages.id))
      .limit(batchSize);
    if (rows.length === 0) break;
    const outcomes = await Promise.allSettled(rows.flatMap((row) => plaintextKeys(row).map((objectKey) => deleteObject("private", objectKey))));
    for (const outcome of outcomes) {
      if (outcome.status !== "rejected") continue;
      failed += 1;
      options.log?.(`sweep: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
    }
    swept += rows.length;
    after = rows[rows.length - 1]!.id;
  }
  return { swept, failed };
}

/** Seals every legacy row, then sweeps and scrubs. Safe to stop and rerun: a row is legacy until its claim commits. */
export async function sealLegacyInbound(options: SealOptions = {}): Promise<SealResult> {
  const batchSize = options.batchSize ?? 100;
  const concurrency = options.concurrency ?? 4;
  const log = options.log ?? (() => {});
  const result: SealResult = { sealed: 0, failed: 0, payloadsScrubbed: 0, swept: 0 };

  if (options.dryRun) {
    log(`${await countLegacyInbound(options.organizationId)} inbound message(s) hold plaintext`);
    return result;
  }

  let after = "";
  for (;;) {
    // Mail about to be purged is left to the retention sweep.
    const now = await dbNow();
    const rows = await db
      .select()
      .from(inboundMessages)
      .where(
        and(
          legacy,
          gt(inboundMessages.id, after),
          gt(inboundMessages.expiresAt, new Date(now.getTime() + 60_000)),
          options.organizationId ? eq(inboundMessages.organizationId, options.organizationId) : undefined,
        ),
      )
      .orderBy(asc(inboundMessages.id))
      .limit(batchSize);
    if (rows.length === 0) break;

    await eachBounded(rows, concurrency, async (row) => {
      try {
        if (await sealRow(row)) result.sealed += 1;
      } catch (err) {
        result.failed += 1;
        log(`${row.id}: ${safeErrorMessage(err)}`);
      }
    });
    after = rows[rows.length - 1]!.id;
    log(`sealed ${result.sealed}, failed ${result.failed}, through ${after}`);
  }

  const sweep = await sweepSealedLegacy({ organizationId: options.organizationId, log });
  result.swept = sweep.swept;
  result.failed += sweep.failed;
  for (;;) {
    const scrubbed = await scrubOrphanedInboundPayloads(db, 1000);
    result.payloadsScrubbed += scrubbed;
    if (scrubbed === 0) break;
  }
  return result;
}
