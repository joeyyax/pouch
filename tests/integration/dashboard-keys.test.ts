import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, messages } from "@/lib/db/schema";
import { authenticateKey } from "@/lib/api/keys";
import { revokeApiKey } from "@/lib/api/key-lifecycle";
import { sha256 } from "@/lib/crypto";
import { dailySendsByKey, listKeys, readKey } from "@/lib/dashboard/keys";
import { KEY_TREND_DAYS } from "@/lib/dashboard/views/keys";
import { createKey } from "@/lib/keys";
import { createKeySchema } from "@/lib/schemas/key";
import { newId } from "@/lib/ids";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

function request(overrides: Partial<{ name: string; mode: "live" | "test"; domain_ids: string[]; rate_limit: number }> = {}) {
  return createKeySchema.parse({
    name: "scope-production",
    mode: "live",
    domain_ids: [],
    rate_limit: 200,
    ...overrides,
  });
}

/** A dashboard session: every domain in the organization, no mode limit. */
function caller(organizationId: string) {
  return { organizationId, domainIds: [], actor: { type: "user" as const, id: null, label: "Test" } };
}

async function create(organizationId: string, overrides = {}) {
  return createKey(caller(organizationId), request(overrides));
}

describe("createKey", () => {
  it("stores only the hash and returns the secret once", async () => {
    const minted = await create(fixture.organizationId, { domain_ids: [fixture.domainId] });

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, minted.id)).limit(1);
    expect(row?.secretHash).toBe(sha256(minted.secret));
    expect(row?.secretPrefix).toBe(minted.secret.slice(0, 16));
    // The secret itself appears in no column.
    expect(JSON.stringify(row)).not.toContain(minted.secret);
    expect(row?.rateLimit).toBe(200);
    expect(row?.domainIds).toEqual([fixture.domainId]);
  });

  it("records it as an organization key, with no creator when nothing supplied one", async () => {
    const minted = await create(fixture.organizationId, { name: "by-user" });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, minted.id)).limit(1);
    expect(row).toMatchObject({ scope: "organization", createdBy: null });
  });

  it("mints a key the API accepts", async () => {
    const minted = await create(fixture.organizationId, { name: "site" });

    const authenticated = await authenticateKey(
      new Request("https://mail.example.com/v1/emails", {
        headers: { authorization: `Bearer ${minted.secret}` },
      }),
    );
    expect(authenticated.id).toBe(minted.id);
  });

  it("marks a test key with its own prefix", async () => {
    const minted = await create(fixture.organizationId, { name: "staging", mode: "test" });
    expect(minted.secret.startsWith("sk_test_")).toBe(true);
    expect(minted.mode).toBe("test");
  });

  it("refuses a domain in another organization", async () => {
    const other = await seedFixture();
    await expect(
      create(fixture.organizationId, { domain_ids: [other.domainId] }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a name a live key already has, and allows it once that key is revoked", async () => {
    await create(fixture.organizationId, { name: "twice" });
    await expect(
      create(fixture.organizationId, { name: "twice" }),
    ).rejects.toMatchObject({ code: "validation_failed" });

    const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.name, "twice")).limit(1);
    await revokeApiKey(fixture.organizationId, existing!.id);
    await expect(create(fixture.organizationId, { name: "twice" })).resolves.toBeTruthy();
  });

  it("rejects a name with characters the form doesn't allow", () => {
    expect(() => request({ name: "scope production" })).toThrow();
    expect(() => request({ name: "" })).toThrow();
  });

  it("rejects a rate limit below one", () => {
    expect(() => request({ rate_limit: 0 })).toThrow();
  });
});

describe("revokeApiKey", () => {
  it("stops the key authenticating and leaves the row", async () => {
    const minted = await create(fixture.organizationId, { name: "gone" });
    const revoked = await revokeApiKey(fixture.organizationId, minted.id);
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    await expect(
      authenticateKey(
        new Request("https://mail.example.com/v1/emails", {
          headers: { authorization: `Bearer ${minted.secret}` },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_key" });

    expect((await listKeys(fixture.organizationId, "UTC")).some((key) => key.id === minted.id)).toBe(true);
  });

  it("won't revoke another organization's key", async () => {
    const other = await seedFixture();
    expect(await revokeApiKey(fixture.organizationId, other.key.id)).toBeNull();

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, other.key.id)).limit(1);
    expect(row?.revokedAt).toBeNull();
  });
});

describe("listKeys and readKey", () => {
  it("names the domains a key is scoped to", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    const detail = await readKey(fixture.organizationId, second.key.id, "UTC");
    expect(detail?.domainNames).toEqual(["second.example.com"]);
  });

  it("won't read another organization's key", async () => {
    const other = await seedFixture();
    expect(await readKey(fixture.organizationId, other.key.id, "UTC")).toBeNull();
    expect(await listKeys(fixture.organizationId, "UTC").then((keys) => keys.map((key) => key.id))).not.toContain(
      other.key.id,
    );
  });

  it("counts every send with the key and lists the most recent five", async () => {
    for (let index = 0; index < 6; index += 1) {
      await db.insert(messages).values({
        id: newId("message"),
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        apiKeyId: fixture.key.id,
        status: "delivered",
        fromAddress: "hi@example.com",
        recipients: ["name@example.com"],
        subject: `Message ${index}`,
        envelope: {
          from: "hi@example.com",
          fromName: null,
          to: ["name@example.com"],
          cc: [],
          bcc: [],
          replyTo: [],
          headers: {},
          attachmentCount: 0,
        },
        tags: [],
        createdAt: new Date(Date.now() - index * 60_000),
      });
    }

    const detail = await readKey(fixture.organizationId, fixture.key.id, "UTC");
    expect(detail?.usageTotal).toBe(6);
    expect(detail?.usage).toHaveLength(5);
    expect(detail?.usage[0]?.subject).toBe("Message 0");
  });
});

describe("dailySendsByKey", () => {
  it("counts each key's sends per UTC day, oldest first, inside the window", async () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const second = await addDomainKey(fixture, "second.example.com");
    await seedMessage(fixture, { apiKeyId: fixture.key.id, createdAt: new Date("2026-09-29T00:10:00Z") });
    await seedMessage(fixture, { apiKeyId: fixture.key.id, createdAt: new Date("2026-09-29T11:00:00Z") });
    await seedMessage(fixture, { apiKeyId: fixture.key.id, createdAt: new Date("2026-08-31T23:59:00Z") });
    await seedMessage(fixture, { apiKeyId: fixture.key.id, createdAt: new Date("2026-08-30T23:59:00Z") });
    await seedMessage(fixture, { apiKeyId: null, createdAt: new Date("2026-09-29T11:00:00Z") });

    const daily = await dailySendsByKey(fixture.organizationId, "UTC", { now });
    const first = daily.get(fixture.key.id);
    expect(first).toHaveLength(KEY_TREND_DAYS);
    expect(first?.[0]).toBe(1);
    expect(first?.[KEY_TREND_DAYS - 1]).toBe(2);
    expect(first?.reduce((total, value) => total + value, 0)).toBe(3);
    expect(daily.has(second.key.id)).toBe(false);
  });

  it("narrows to one key", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await seedMessage(fixture, { apiKeyId: fixture.key.id });
    await seedMessage(fixture, { apiKeyId: second.key.id });

    const daily = await dailySendsByKey(fixture.organizationId, "UTC", { apiKeyId: second.key.id });
    expect([...daily.keys()]).toEqual([second.key.id]);
    expect(daily.get(second.key.id)?.at(-1)).toBe(1);
  });

  it("gives a key with no sends a row of zeros on the list", async () => {
    const [listed] = await listKeys(fixture.organizationId, "UTC");
    expect(listed?.daily).toEqual(Array.from({ length: KEY_TREND_DAYS }, () => 0));
  });
});
