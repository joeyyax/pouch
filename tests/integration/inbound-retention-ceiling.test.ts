import { generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { domains, inboundMessages } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { newMessageKey } from "@/lib/crypto";
import { newId } from "@/lib/ids";
import { newInboundStorageKey, writeInboundBody } from "@/lib/inbound/attachments";
import { receiveInbound } from "@/lib/inbound/ingest";
import { updateInboundSettings } from "@/lib/inbound/manage";
import { setSetting } from "@/lib/settings/values";
import { upsertDomainEndpoint } from "@/lib/webhooks/endpoints";
import { InboundRetentionLoop } from "@/worker/inbound-retention";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));

const DAY = 24 * 60 * 60 * 1000;
const ADMIN = adminActor("usr_admin", "Admin");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ providerAdapter: "mailpace" });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** A stored message received `receivedAgo` days back, expiring `expiresIn` days from now. */
async function stored(receivedAgo: number, expiresIn: number): Promise<string> {
  const id = newId("inbound");
  const { key, encoded } = newMessageKey();
  const storageKey = newInboundStorageKey();
  await writeInboundBody(key, storageKey, { text: "hello", html: null });
  await db.insert(inboundMessages).values({
    id,
    organizationId: fixture.organizationId,
    domainId: fixture.domainId,
    fromAddress: "ada@example.net",
    to: ["reply@inbound.example.com"],
    subject: "Hi",
    threadId: newId("thread"),
    bodyKey: encoded,
    storageKey,
    receivedAt: new Date(Date.now() - receivedAgo * DAY),
    expiresAt: new Date(Date.now() + expiresIn * DAY),
  });
  return id;
}

async function left(): Promise<string[]> {
  const rows = await db.select({ id: inboundMessages.id }).from(inboundMessages);
  return rows.map((row) => row.id).sort();
}

function sweep() {
  return new InboundRetentionLoop({ intervalMs: 60_000, batchSize: 100 }).tick();
}

describe("the inbound sweep under a ceiling", () => {
  it("purges at the ceiling when it's below the domain's window, and at the domain's window otherwise", async () => {
    const old = await stored(15, 15);
    const recent = await stored(5, 25);

    await sweep();
    expect(await left()).toEqual([old, recent].sort());

    await setSetting("inbound_retention_max_days", 10, ADMIN);
    await sweep();
    expect(await left()).toEqual([recent]);
  });

  it("stamps new mail with the smaller of the domain's window and the ceiling", async () => {
    await db
      .update(domains)
      .set({ inboundEnabled: true, inboundRetentionDays: 7, inboundProviderSettings: { webhookPublicKey: publicKey } })
      .where(eq(domains.id, fixture.domainId));
    await upsertDomainEndpoint(fixture.organizationId, fixture.domainId, "https://receiver.example.net/hook");
    await setSetting("inbound_retention_max_days", 3, ADMIN);

    const body = JSON.stringify({ id: 9, from: "ada@example.net", to: "reply@inbound.example.com", subject: "Hi", text: "hi" });
    const outcome = await receiveInbound("mailpace", fixture.domainId, {
      rawBody: body,
      headers: { "x-mailpace-signature": sign(null, Buffer.from(body), keys.privateKey).toString("base64") },
    });
    expect(outcome.result).toEqual({ accepted: 1, duplicates: 0 });

    const [row] = await db.select().from(inboundMessages);
    expect(row!.expiresAt.getTime() - row!.receivedAt.getTime()).toBeCloseTo(3 * DAY, -4);
  });
});

describe("a domain's retention window", () => {
  const caller = () => ({ organizationId: fixture.organizationId, actor: ADMIN });

  it("is refused above the live ceiling, naming it", async () => {
    await setSetting("inbound_retention_max_days", 60, ADMIN);
    await expect(updateInboundSettings(caller(), fixture.domainId, { enabled: false, retention_days: 61 })).rejects.toMatchObject({
      code: "validation_failed",
      field: "retention_days",
      detail: { max: 60 },
    });
    await expect(updateInboundSettings(caller(), fixture.domainId, { enabled: false, retention_days: 60 })).resolves.toBeDefined();
  });

  it("follows a ceiling from the environment", async () => {
    vi.stubEnv("INBOUND_RETENTION_MAX_DAYS", "5");
    await expect(updateInboundSettings(caller(), fixture.domainId, { enabled: false, retention_days: 6 })).rejects.toMatchObject({
      detail: { max: 5 },
    });
  });
});

describe("the inbound ceiling setting", () => {
  it("holds to its hard bound", async () => {
    await expect(setSetting("inbound_retention_max_days", 366, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    await expect(setSetting("inbound_retention_max_days", 0, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
    await setSetting("inbound_retention_max_days", 365, ADMIN);
  });
});
