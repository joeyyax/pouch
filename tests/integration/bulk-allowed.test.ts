import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messages } from "@/lib/db/schema";
import { apiKeyActor } from "@/lib/activity/record";
import { createBatch, type BatchCaller } from "@/lib/bulk/create";
import { setBulkAllowed, type DomainCaller } from "@/lib/domains";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

function batchCaller(f: Fixture): BatchCaller {
  return { organizationId: f.organizationId, domainIds: [f.domainId], apiKeyId: f.key.id, mode: "live" };
}

function domainCaller(f: Fixture): DomainCaller {
  return { organizationId: f.organizationId, domainIds: [f.domainId], actor: apiKeyActor(f.key.id, f.key.name) };
}

async function sendBatch(f: Fixture) {
  return createBatch(batchCaller(f), {
    from: "Ada <ada@example.com>",
    subject: "Notice",
    html: "<p>Hi {{name}}.</p>",
    recipients: [{ address: "person@example.net", attributes: { name: "Person" } }],
  });
}

describe("bulk_allowed (#246)", () => {
  it("defaults every domain to disabled", async () => {
    const [row] = await db.select({ bulkAllowed: domains.bulkAllowed }).from(domains).where(eq(domains.id, fixture.domainId));
    expect(row?.bulkAllowed).toBe(false);
  });

  it("sends a batch once an enabled domain's provider can do bulk", async () => {
    // mock's capabilities.bulk is true; the fixture defaults to that adapter.
    await setBulkAllowed(domainCaller(fixture), fixture.domainId, true);

    const batch = await sendBatch(fixture);
    expect(batch.recipient_count).toBe(1);

    const rows = await db.select().from(messages).where(eq(messages.batchId, batch.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("queued");
  });

  it("refuses a disabled domain on a capable provider with the turned-off reason", async () => {
    // Never enabled — stays at the schema default.
    await expect(sendBatch(fixture)).rejects.toMatchObject({
      code: "bulk_not_allowed",
      detail: { reason: "domain_disabled" },
    });

    const rows = await db.select().from(messages);
    expect(rows).toHaveLength(0);
  });

  it("refuses turning bulk_allowed on for a provider that can't do bulk, with the provider reason", async () => {
    const mailpace = await seedFixture({ providerAdapter: "mailpace" });

    await expect(setBulkAllowed(domainCaller(mailpace), mailpace.domainId, true)).rejects.toMatchObject({
      code: "bulk_not_allowed",
      detail: { reason: "provider_incapable" },
    });

    const [row] = await db.select({ bulkAllowed: domains.bulkAllowed }).from(domains).where(eq(domains.id, mailpace.domainId));
    expect(row?.bulkAllowed).toBe(false);

    // The provider fact wins even at send time too, independent of the toggle write above.
    await expect(sendBatch(mailpace)).rejects.toMatchObject({
      code: "bulk_not_allowed",
      detail: { reason: "provider_incapable" },
    });
  });

  it("turning bulk_allowed off is always accepted, even for a provider-incapable domain", async () => {
    const mailpace = await seedFixture({ providerAdapter: "mailpace" });
    const result = await setBulkAllowed(domainCaller(mailpace), mailpace.domainId, false);
    expect(result.bulk_allowed).toBe(false);
  });
});
