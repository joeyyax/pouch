import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains, lists, type MessageStatus } from "@/lib/db/schema";
import { listDomains, listDomainNames, listProviderOptions, readDomain, readDomainKeys, readDomainSuppressions } from "@/lib/dashboard/domains";
import { RATE_WINDOW_DAYS } from "@/lib/metrics/window";
import { createDomain, deleteDomain, type DomainCaller } from "@/lib/domains";
import { userActor } from "@/lib/activity/record";
import { recordEvent } from "@/lib/messages/events";
import { suppress } from "@/lib/messages/suppression";
import { generateKeySecret } from "@/lib/api/keys";
import { newId } from "@/lib/ids";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

let fixture: Fixture;

/** What a dashboard session is: the organization, and no domain scope at all. */
function session(organizationId: string): DomainCaller {
  return { organizationId, domainIds: [] as string[], actor: userActor("u_test", "Test") };
}

async function insertMessage(
  fixtureIn: Fixture,
  domainId: string,
  to = "name@example.com",
  { status = "delivered", createdAt }: { status?: MessageStatus; createdAt?: Date } = {},
): Promise<string> {
  return seedMessage({ organizationId: fixtureIn.organizationId, domainId }, { to, status, ...(createdAt ? { createdAt } : {}) });
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("listDomains", () => {
  it("counts a message once, by its status, however many events it has", async () => {
    const complained = await insertMessage(fixture, fixture.domainId, "a@example.com", { status: "complained" });
    for (const status of ["queued", "sent", "delivered", "complained"] as const) {
      await recordEvent({ organizationId: fixture.organizationId, messageId: complained, status });
    }
    const delivered = await insertMessage(fixture, fixture.domainId, "b@example.com");
    await recordEvent({ organizationId: fixture.organizationId, messageId: delivered, status: "delivered" });

    const [row] = await listDomains(fixture.organizationId, "UTC");
    expect(row).toMatchObject({ delivered: 1, bounced: 0, complained: 1, failed: 0 });
  });

  it("counts messages created in the window, not events that land in it", async () => {
    const old = new Date(Date.now() - (RATE_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
    const messageId = await insertMessage(fixture, fixture.domainId, "a@example.com", { status: "bounced", createdAt: old });
    await recordEvent({ organizationId: fixture.organizationId, messageId, status: "bounced" });

    const [row] = await listDomains(fixture.organizationId, "UTC");
    expect(row).toMatchObject({ delivered: 0, bounced: 0 });
  });

  it("carries complained and failed counts too", async () => {
    for (const status of ["delivered", "bounced", "complained", "failed"] as const) {
      await insertMessage(fixture, fixture.domainId, `${status}@example.com`, { status });
    }

    const [row] = await listDomains(fixture.organizationId, "UTC");
    expect(row).toMatchObject({ delivered: 1, bounced: 1, complained: 1, failed: 1 });
  });

  it("buckets delivered messages by UTC day, oldest first, summing to the delivered count", async () => {
    const day = 24 * 60 * 60 * 1000;
    await insertMessage(fixture, fixture.domainId, "a@example.com", { createdAt: new Date(Date.now() - 2 * day) });
    await insertMessage(fixture, fixture.domainId, "b@example.com", { createdAt: new Date(Date.now() - 2 * day) });
    await insertMessage(fixture, fixture.domainId, "c@example.com");
    await insertMessage(fixture, fixture.domainId, "d@example.com", { status: "bounced" });
    await insertMessage(fixture, fixture.domainId, "e@example.com", { createdAt: new Date(Date.now() - (RATE_WINDOW_DAYS + 1) * day) });

    const [row] = await listDomains(fixture.organizationId, "UTC");
    expect(row?.deliveredDaily).toHaveLength(RATE_WINDOW_DAYS + 1);
    expect(row?.deliveredDaily.at(-1)).toBe(1);
    expect(row?.deliveredDaily.at(-3)).toBe(2);
    expect(row?.deliveredDaily.reduce((sum, count) => sum + count, 0)).toBe(row?.delivered);
  });

  it("leaves out another organization's domains and events", async () => {
    const other = await seedFixture();
    const theirs = await insertMessage(other, other.domainId);
    await recordEvent({ organizationId: other.organizationId, messageId: theirs, status: "delivered" });

    const rows = await listDomains(fixture.organizationId, "UTC");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivered).toBe(0);
    expect(await listDomainNames(other.organizationId)).toEqual(["example.com"]);
  });

  it("counts a key scoped to nothing against every domain", async () => {
    await addDomainKey(fixture, "second.example.com");
    const generated = generateKeySecret("live");
    await db.insert(apiKeys).values({
      id: newId("key"),
      organizationId: fixture.organizationId,
      name: "unscoped",
      secretHash: generated.secretHash,
      secretPrefix: generated.secretPrefix,
      mode: "live",
      domainIds: [],
    });

    const rows = await listDomains(fixture.organizationId, "UTC");
    const byName = new Map(rows.map((row) => [row.name, row]));
    // example.com has its own key plus the unscoped one; second has its own plus the unscoped one.
    expect(byName.get("example.com")?.keyCount).toBe(2);
    expect(byName.get("second.example.com")?.keyCount).toBe(2);
  });

  it("sorts verified before pending before failed", async () => {
    const second = await addDomainKey(fixture, "b.example.com");
    await db.update(domains).set({ status: "failed" }).where(eq(domains.id, fixture.domainId));
    await db.update(domains).set({ status: "verified" }).where(eq(domains.id, second.domainId));

    expect((await listDomains(fixture.organizationId, "UTC")).map((row) => row.name)).toEqual([
      "b.example.com",
      "example.com",
    ]);
  });
});

describe("readDomain", () => {
  it("won't read another organization's domain", async () => {
    const other = await seedFixture();
    expect(await readDomain(session(fixture.organizationId), other.domainId)).toBeNull();
    expect(await readDomain(session(other.organizationId), other.domainId)).not.toBeNull();
  });

  it("reports the records the last check couldn't see", async () => {
    await db
      .update(domains)
      .set({
        status: "pending",
        lastCheckedAt: new Date(),
        dnsRecords: [
          { type: "CNAME", name: "a._domainkey.example.com", value: "a.dkim.test", required: true },
          { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=none", required: false },
        ],
        missingRecords: [{ type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=none", required: false }],
      })
      .where(eq(domains.id, fixture.domainId));

    const domain = await readDomain(session(fixture.organizationId), fixture.domainId);
    expect(domain?.missingRecords).toEqual(["TXT:_dmarc.example.com"]);
    expect(domain?.dnsRecords).toHaveLength(2);
  });

  it("finds suppressions through the message that caused them", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    const here = await insertMessage(fixture, fixture.domainId, "bounced@example.com");
    const elsewhere = await insertMessage(fixture, second.domainId, "other@example.com");

    await suppress({
      organizationId: fixture.organizationId,
      address: "bounced@example.com",
      reason: "hard_bounce",
      sourceMessageId: here,
    });
    await suppress({
      organizationId: fixture.organizationId,
      address: "other@example.com",
      reason: "complaint",
      sourceMessageId: elsewhere,
    });
    // A manual suppression belongs to no domain and must not appear under one.
    await suppress({ organizationId: fixture.organizationId, address: "manual@example.com", reason: "manual" });

    const found = await readDomainSuppressions(session(fixture.organizationId), fixture.domainId);
    expect(found.map((entry) => entry.address)).toEqual(["bounced@example.com"]);
  });

  it("lists keys limited to the domain, and counts live ones limited to none", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    for (const revoked of [false, true]) {
      const generated = generateKeySecret("live");
      await db.insert(apiKeys).values({
        id: newId("key"),
        organizationId: fixture.organizationId,
        name: revoked ? "unscoped, revoked" : "unscoped",
        secretHash: generated.secretHash,
        secretPrefix: generated.secretPrefix,
        mode: "live",
        domainIds: [],
        revokedAt: revoked ? new Date() : null,
      });
    }

    const keys = await readDomainKeys(session(fixture.organizationId), second.domainId);
    // The fixture's own key is limited to example.com and doesn't reach here.
    expect(keys.keys.map((key) => key.id)).toEqual([second.key.id]);
    expect(keys.unscopedKeys).toBe(1);
  });

  it("names live keys for the delete dialog only while the domain can go", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    expect((await readDomain(session(fixture.organizationId), second.domainId))?.liveScopedKeys?.map((key) => key.id)).toEqual([
      second.key.id,
    ]);
    await insertMessage(fixture, second.domainId);
    expect((await readDomain(session(fixture.organizationId), second.domainId))?.liveScopedKeys).toBeNull();
  });

  it("says whether anything has been sent from the domain", async () => {
    expect((await readDomain(session(fixture.organizationId), fixture.domainId))?.deleteBlock).toBeNull();
    await insertMessage(fixture, fixture.domainId);
    expect((await readDomain(session(fixture.organizationId), fixture.domainId))?.deleteBlock?.message).toContain("has messages");
  });

  it("names the lists that block a delete, so the operator can reach them", async () => {
    await db.insert(lists).values({
      id: newId("list"),
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      name: "Announcements",
    });

    const block = (await readDomain(session(fixture.organizationId), fixture.domainId))?.deleteBlock;

    expect(block?.message).toBe("Domain example.com has 1 list and can't be deleted: Announcements. Delete it first.");
    expect(block?.lists.map((list) => list.name)).toEqual(["Announcements"]);
  });
});

describe("a dashboard session as a domain caller", () => {
  it("adds a domain", async () => {
    const provider = (await listProviderOptions(fixture.organizationId))[0];
    const created = await createDomain(session(fixture.organizationId), {
      name: "new.example.com",
      provider_id: provider!.id,
    });
    expect(created.status).toBe("pending");
  });

  it("refuses a name the organization already has", async () => {
    const provider = (await listProviderOptions(fixture.organizationId))[0];
    await expect(
      createDomain(session(fixture.organizationId), {
        name: "example.com",
        provider_id: provider!.id,
      }),
    ).rejects.toMatchObject({ code: "domain_exists" });
  });

  it("refuses to delete a domain that has sent", async () => {
    await insertMessage(fixture, fixture.domainId);
    await expect(deleteDomain(session(fixture.organizationId), fixture.domainId)).rejects.toMatchObject({
      code: "domain_in_use",
    });
    // The row is still there.
    expect(await readDomain(session(fixture.organizationId), fixture.domainId)).not.toBeNull();
  });

  it("won't reach a domain in another organization", async () => {
    const other = await seedFixture();
    await expect(deleteDomain(session(fixture.organizationId), other.domainId)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
