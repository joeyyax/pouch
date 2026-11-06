import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, providers } from "@/lib/db/schema";
import { moveDomain, type DomainCaller } from "@/lib/domains";
import { userActor } from "@/lib/activity/record";
import { VerifyLoop, recheckDueBefore } from "@/worker/verify";
import { addProvider, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const { sesSend } = vi.hoisted(() => ({ sesSend: vi.fn() }));

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sesv2")>();
  return {
    ...actual,
    SESv2Client: class {
      send(command: object) {
        return sesSend(command);
      }
    },
  };
});

function loop(recheckAfterMs = 0): VerifyLoop {
  return new VerifyLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs });
}

async function row(id: string) {
  const [found] = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
  if (!found) throw new Error(`domain ${id} disappeared`);
  return found;
}

async function pending(fixture: Fixture): Promise<string> {
  await db.update(domains).set({ status: "pending", verifiedAt: null }).where(eq(domains.id, fixture.domainId));
  return fixture.domainId;
}

const DKIM_FAILED = "DKIM verification is FAILED. Recreate the domain.";

async function failed(fixture: Fixture): Promise<string> {
  await db
    .update(domains)
    .set({ status: "failed", verifiedAt: null, verificationErrors: [DKIM_FAILED] })
    .where(eq(domains.id, fixture.domainId));
  return fixture.domainId;
}

function slowLoop(): VerifyLoop {
  return new VerifyLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 5 * 60_000, slowRecheckAfterMs: 60 * 60_000 });
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});
afterEach(() => vi.unstubAllGlobals());

describe("VerifyLoop", () => {
  it("flips a pending domain the provider has verified", async () => {
    const id = await pending(fixture);

    const checked = await loop().tick();

    expect(checked).toBe(1);
    const after = await row(id);
    expect(after.status).toBe("verified");
    expect(after.verifiedAt).not.toBeNull();
    expect(after.lastCheckedAt).not.toBeNull();
  });

  it("re-checks a failed domain, so fixing the DNS brings it back without a manual verify", async () => {
    const id = await failed(fixture);

    const checked = await loop().tick();

    expect(checked).toBe(1);
    const after = await row(id);
    expect(after.status).toBe("verified");
    expect(after.verifiedAt).not.toBeNull();
    expect(after.verificationErrors).toEqual([]);
  });

  it("polls a failed domain on the slow schedule, not the fast one", async () => {
    const id = await failed(fixture);
    await db.update(domains).set({ lastCheckedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(domains.id, id));

    expect(await slowLoop().tick()).toBe(0);
    expect((await row(id)).status).toBe("failed");
  });

  it("re-checks a failed domain once the slow interval has passed", async () => {
    const id = await failed(fixture);
    await db.update(domains).set({ lastCheckedAt: new Date(Date.now() - 2 * 60 * 60_000) }).where(eq(domains.id, id));

    expect(await slowLoop().tick()).toBe(1);
    expect((await row(id)).status).toBe("verified");
  });

  it("leaves a verified domain alone", async () => {
    const checked = await loop().tick();

    expect(checked).toBe(0);
    expect((await row(fixture.domainId)).lastCheckedAt).toBeNull();
  });

  it("waits out the recheck interval before asking again", async () => {
    const id = await pending(fixture);
    await loop(0).tick();
    await db.update(domains).set({ status: "pending", verifiedAt: null }).where(eq(domains.id, id));

    expect(await loop(5 * 60_000).tick()).toBe(0);
  });

  it("checks a domain whose provider is backing off, since verification isn't sending", async () => {
    const id = await pending(fixture);
    await db
      .update(providers)
      .set({ backoffUntil: new Date(Date.now() + 60_000) })
      .where(eq(providers.id, fixture.providerId));

    expect(await loop().tick()).toBe(1);
    expect((await row(id)).status).toBe("verified");
  });

  it("leaves a domain pending while the provider still can't see its records", async () => {
    const mailpace = await seedFixture({
      domainStatus: "pending",
      providerAdapter: "mailpace",
      credentials: { serverToken: "t", organizationToken: "org-token" },
    });
    await db
      .update(domains)
      .set({ providerDomainId: "12" })
      .where(eq(domains.id, mailpace.domainId));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 12, dkim_verified: false, errors: {} })));

    await loop().tick();

    const after = await row(mailpace.domainId);
    expect(after.status).toBe("pending");
    expect(after.verifiedAt).toBeNull();
    expect(after.lastCheckedAt).not.toBeNull();
  });

  it("fails a domain when the provider reports a terminal error, storing the reasons", async () => {
    const mailpace = await seedFixture({
      domainStatus: "pending",
      providerAdapter: "mailpace",
      credentials: { serverToken: "t", organizationToken: "org-token" },
    });
    await db.update(domains).set({ providerDomainId: "12" }).where(eq(domains.id, mailpace.domainId));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: 12,
          dkim_verified: false,
          dkim_host: "mailpace._domainkey.example.com",
          dkim_value: "v=DKIM1; k=rsa; p=recorded",
          errors: { dkim: "DKIM verification is FAILED. Recreate the domain." },
        }),
      ),
    );

    await loop().tick();

    const after = await row(mailpace.domainId);
    expect(after.status).toBe("failed");
    expect(after.verifiedAt).toBeNull();
    expect(after.verificationErrors).toEqual(["DKIM verification is FAILED. Recreate the domain."]);
  });

  it("stamps the check even when the provider throws, so one broken domain can't hot-loop", async () => {
    const broken = await seedFixture({
      domainStatus: "pending",
      providerAdapter: "mailpace",
      credentials: { serverToken: "t" },
    });
    await db.update(domains).set({ providerDomainId: "12" }).where(eq(domains.id, broken.domainId));

    await expect(loop().tick()).resolves.toBeGreaterThan(0);

    const after = await row(broken.domainId);
    expect(after.status).toBe("pending");
    expect(after.lastCheckedAt).not.toBeNull();
  });

  it("keeps checking other domains after one throws", async () => {
    const good = await pending(fixture);
    const broken = await seedFixture({ domainStatus: "pending", providerAdapter: "mailpace" });
    await db.update(domains).set({ providerDomainId: "12" }).where(eq(domains.id, broken.domainId));

    await loop().tick();

    expect((await row(good)).status).toBe("verified");
  });

  it("stamps a domain it can't check, so it doesn't refill the batch every pass", async () => {
    const id = await pending(fixture);
    await db.update(providers).set({ adapter: "nocheck" }).where(eq(providers.id, fixture.providerId));

    await loop().tick();

    expect((await row(id)).lastCheckedAt).not.toBeNull();
    expect((await row(id)).status).toBe("pending");
  });

  it("doesn't starve a checkable domain sitting behind one it can't check", async () => {
    const stuck = await seedFixture({ domainStatus: "pending" });
    await db.update(providers).set({ adapter: "nocheck" }).where(eq(providers.id, stuck.providerId));
    const good = await pending(fixture);

    await new VerifyLoop({ intervalMs: 60_000, batchSize: 1, recheckAfterMs: 0 }).tick();
    await new VerifyLoop({ intervalMs: 60_000, batchSize: 1, recheckAfterMs: 0 }).tick();

    expect((await row(good)).status).toBe("verified");
  });
});

describe("a pending move to another provider", () => {
  async function pendingMove(): Promise<{ target: string }> {
    const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });
    const caller: DomainCaller = { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u_test", "Test") };
    await moveDomain(caller, fixture.domainId, target.providerId);
    return { target: target.providerId };
  }

  it("cuts the domain over once the pending binding verifies with nothing missing", async () => {
    const { target } = await pendingMove();

    expect(await loop().tick()).toBe(1);

    const after = await row(fixture.domainId);
    expect(after.providerId).toBe(target);
    expect(after.status).toBe("verified");
    expect(after.pendingProviderId).toBeNull();
    expect(after.pendingDnsRecords).toEqual([]);
    expect(after.pendingMissingRecords).toEqual([]);
    expect(after.pendingStartedAt).toBeNull();
  });

  it("leaves the live binding untouched while the pending provider isn't checkable yet", async () => {
    const { target } = await pendingMove();
    await db.update(providers).set({ adapter: "nocheck" }).where(eq(providers.id, target));

    await loop().tick();

    const after = await row(fixture.domainId);
    expect(after.providerId).toBe(fixture.providerId);
    expect(after.pendingProviderId).toBe(target);
  });

  it("waits out the recheck interval before asking the target again", async () => {
    await pendingMove();
    await db.update(domains).set({ pendingLastCheckedAt: new Date() }).where(eq(domains.id, fixture.domainId));

    expect(await loop(5 * 60_000).tick()).toBe(0);
    const after = await row(fixture.domainId);
    expect(after.pendingProviderId).not.toBeNull();
  });

  it("cancels a move nobody ever verified, once it's older than the expiry window", async () => {
    await pendingMove();
    await db
      .update(domains)
      .set({ pendingStartedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) })
      .where(eq(domains.id, fixture.domainId));

    const expiring = new VerifyLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0, pendingExpiresAfterMs: 14 * 24 * 60 * 60 * 1000 });
    expect(await expiring.tick()).toBeGreaterThan(0);

    const after = await row(fixture.domainId);
    expect(after.providerId).toBe(fixture.providerId);
    expect(after.pendingProviderId).toBeNull();
  });

  it("keeps an expired move and retries later when the target can't drop its identity", async () => {
    const target = await addProvider(fixture, {
      providerAdapter: "ses",
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-west-2" },
      settings: { configurationSetName: "set", topicArn: "arn:aws:sns:us-west-2:123456789012:t", subscriptionConfirmed: "true" },
    });
    sesSend.mockReset();
    sesSend.mockResolvedValue({ DkimAttributes: { Tokens: ["t"] } });
    const caller: DomainCaller = { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u_test", "Test") };
    await moveDomain(caller, fixture.domainId, target.providerId);
    await db
      .update(domains)
      .set({ pendingStartedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) })
      .where(eq(domains.id, fixture.domainId));
    sesSend.mockRejectedValue(Object.assign(new Error("Rate exceeded."), { name: "TooManyRequestsException" }));

    const expiring = new VerifyLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0, pendingExpiresAfterMs: 14 * 24 * 60 * 60 * 1000 });
    await expiring.tick();

    const after = await row(fixture.domainId);
    expect(after.pendingProviderId).toBe(target.providerId);
    expect(after.pendingLastCheckedAt).not.toBeNull();
  });
});

describe("recheck backoff", () => {
  const minutes = (count: number) => count * 60_000;

  it("re-checks every few minutes while a domain is new", () => {
    const created = new Date("2026-09-08T10:00:00.000Z");
    const now = new Date("2026-09-08T10:30:00.000Z");

    expect(recheckDueBefore({ createdAt: created, now, fastMs: minutes(5), slowMs: minutes(60), status: "pending" })).toEqual(
      new Date(now.getTime() - minutes(5)),
    );
  });

  it("drops to hourly once a domain has been pending for an hour", () => {
    const created = new Date("2026-09-08T10:00:00.000Z");
    const now = new Date("2026-09-08T13:00:00.000Z");

    expect(recheckDueBefore({ createdAt: created, now, fastMs: minutes(5), slowMs: minutes(60), status: "pending" })).toEqual(
      new Date(now.getTime() - minutes(60)),
    );
  });

  it("polls a failed domain at the slow interval however young it is", () => {
    const created = new Date("2026-09-08T10:00:00.000Z");
    const now = new Date("2026-09-08T10:30:00.000Z");

    expect(recheckDueBefore({ createdAt: created, now, fastMs: minutes(5), slowMs: minutes(60), status: "failed" })).toEqual(
      new Date(now.getTime() - minutes(60)),
    );
  });

  it("leaves a domain checked within its interval alone once it's slowed down", async () => {
    const id = await pending(fixture);
    await db
      .update(domains)
      .set({ createdAt: new Date(Date.now() - 3 * 60 * 60_000), lastCheckedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(domains.id, id));

    const checked = await new VerifyLoop({
      intervalMs: 60_000,
      batchSize: 10,
      recheckAfterMs: 5 * 60_000,
      slowRecheckAfterMs: 60 * 60_000,
    }).tick();

    expect(checked).toBe(0);
  });

  it("still checks a young domain last looked at ten minutes ago", async () => {
    const id = await pending(fixture);
    await db.update(domains).set({ lastCheckedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(domains.id, id));

    const checked = await new VerifyLoop({
      intervalMs: 60_000,
      batchSize: 10,
      recheckAfterMs: 5 * 60_000,
      slowRecheckAfterMs: 60 * 60_000,
    }).tick();

    expect(checked).toBe(1);
  });
});
