import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { dnsProviderRecords, domains } from "@/lib/db/schema";
import { userActor } from "@/lib/activity/record";
import { createDnsProviderAccount } from "@/lib/dns-providers/accounts";
import { addMockZone, resetMockZones } from "@/lib/dns-providers/mock";
import { moveDomain, type DomainCaller } from "@/lib/domains";
import { applyDnsPlan, applyPendingDnsPlan } from "@/lib/domains/dns-apply";
import { planDnsCleanup, removeDnsProvenance } from "@/lib/domains/dns-cleanup";
import { planDomainDns } from "@/lib/domains/dns-plan";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { VerifyLoop } from "@/worker/verify";
import { addProvider, resetDatabase, seedFixture, type Fixture } from "./fixtures";

// The mock email provider's `domain.create()` always proposes the same TXT record for a given
// domain name (lib/providers/adapters/mock.ts), regardless of which account asks — so the "new account"
// record here is that fixed mock output, and the "old account" record is set by hand on the
// domain row, the same way domains-dns-apply.test.ts's `setRequired` does. What matters for
// these tests is that the two required sets differ, not which provider produced them. A DKIM
// CNAME at its own name (rather than MX at the apex) keeps the two sets' (type, name) pairs
// disjoint, so which one is "safe to remove" turns only on what #212 adds — not on the
// pre-existing, unrelated MX-priority proxy `dns-cleanup.ts` already refuses through when an
// MX's currently-required priority can't be determined.
const oldDkim: ProposedDnsRecord = { type: "CNAME", name: "old._domainkey.example.com", value: "old.dkim.oldprovider.example.net", required: true };
const NEW_ACCOUNT_TXT_NAME = "mock._domainkey.example.com";

let fixture: Fixture;

function caller(): DomainCaller {
  return { organizationId: fixture.organizationId, domainIds: [] as string[], actor: userActor("u_test", "Test") };
}

async function domainRow() {
  const [found] = await db.select().from(domains).where(eq(domains.id, fixture.domainId)).limit(1);
  if (!found) throw new Error("domain disappeared");
  return found;
}

async function provenanceRows() {
  return db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
}

/** Applies the old account's plan, starts a move, then applies the pending (new account's) plan too — the state a real staged move is in mid-cutover. */
async function applyOldThenStartAndApplyPending(): Promise<{ targetAccountId: string }> {
  await db.update(domains).set({ dnsRecords: [oldDkim] }).where(eq(domains.id, fixture.domainId));
  await applyDnsPlan(caller(), fixture.domainId);

  const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });
  await moveDomain(caller(), fixture.domainId, target.providerId);
  await applyPendingDnsPlan(caller(), fixture.domainId);

  return { targetAccountId: target.providerId };
}

beforeEach(async () => {
  await resetDatabase();
  resetMockZones();
  fixture = await seedFixture();
  addMockZone({ name: "example.com", id: "mock_zone_example.com" }, []);
  await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "dns", credentials: {} });
});
afterEach(() => resetMockZones());

describe("a pending binding's required records", () => {
  it("get a reconciliation plan of their own", async () => {
    const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });
    await moveDomain(caller(), fixture.domainId, target.providerId);

    const domain = await domainRow();
    const plan = await planDomainDns(fixture.organizationId, { name: domain.name, dnsRecords: domain.pendingDnsRecords });
    expect(plan.status).toBe("ready");
    expect(plan.steps).toEqual([expect.objectContaining({ verdict: "create", record: expect.objectContaining({ name: NEW_ACCOUNT_TXT_NAME }) })]);
  });

  it("can be applied the same way an ordinary domain's can, coexisting with what the old account still has published", async () => {
    await db.update(domains).set({ dnsRecords: [oldDkim] }).where(eq(domains.id, fixture.domainId));
    await applyDnsPlan(caller(), fixture.domainId);

    const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });
    await moveDomain(caller(), fixture.domainId, target.providerId);

    const result = await applyPendingDnsPlan(caller(), fixture.domainId);
    expect(result.steps).toEqual([expect.objectContaining({ status: "applied" })]);

    // Both the old account's DKIM CNAME and the new account's TXT are live and tracked — the
    // pending apply never touched or replaced what the old account already published.
    const rows = await provenanceRows();
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.type === "CNAME" && row.writtenValue === oldDkim.value)).toBe(true);
    expect(rows.some((row) => row.type === "TXT" && row.name === NEW_ACCOUNT_TXT_NAME)).toBe(true);

    // Each row carries the email account whose requirements wrote it (#239): the old account's
    // CNAME and the pending target's TXT, even though both are live at once mid-move.
    expect(rows.find((row) => row.type === "CNAME")?.providerId).toBe(fixture.providerId);
    expect(rows.find((row) => row.type === "TXT")?.providerId).toBe(target.providerId);

    // Sending stays on the old account until cutover — applying the pending plan never touches it.
    const domain = await domainRow();
    expect(domain.dnsRecords).toEqual([oldDkim]);
  });

  it("reports no_account/ready with nothing to do when there's no pending move", async () => {
    const result = await applyPendingDnsPlan(caller(), fixture.domainId);
    expect(result).toEqual({ status: "ready", zoneName: null, steps: [], detail: null });
  });
});

describe("cutover completing", () => {
  it("never triggers an automatic DNS removal", async () => {
    await applyOldThenStartAndApplyPending();
    const beforeRows = await provenanceRows();
    expect(beforeRows).toHaveLength(2);

    const loop = new VerifyLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0 });
    await loop.tick();

    const domain = await domainRow();
    expect(domain.status).toBe("verified");
    expect(domain.pendingProviderId).toBeNull();

    // Cutover flipped the live binding, but every provenance row — old account's and new
    // account's alike — is exactly as it was the moment before the tick ran.
    const afterRows = await provenanceRows();
    expect(afterRows).toEqual(beforeRows);

    // And both records are still published live: cutover reconciles nothing away.
    const { mock } = await import("@/lib/dns-providers/mock");
    const provider = mock.create({}, {}, "acc");
    const zone = { name: "example.com", id: "mock_zone_example.com" };
    const live = await provider.getRecords(zone);
    expect(live.some((record) => record.type === "CNAME")).toBe(true);
    expect(live.some((record) => record.type === "TXT" && record.name === NEW_ACCOUNT_TXT_NAME)).toBe(true);
  });
});

describe("the post-cutover cleanup action", () => {
  async function cutOver(): Promise<void> {
    await applyOldThenStartAndApplyPending();
    await new VerifyLoop({ intervalMs: 60_000, batchSize: 10, recheckAfterMs: 0 }).tick();
  }

  it("removes only the previous account's provenance-tracked records", async () => {
    await cutOver();

    const plan = await planDnsCleanup(caller(), fixture.domainId, "previous_account");
    expect(plan.steps).toEqual([expect.objectContaining({ type: "CNAME", status: "removable" })]);

    const result = await removeDnsProvenance(caller(), fixture.domainId, "previous_account");
    expect(result.steps).toEqual([expect.objectContaining({ type: "CNAME", outcome: "removed" })]);

    // The old account's DKIM CNAME is gone; the new account's TXT — what the domain now sends
    // through — was never a candidate and is still tracked and still live.
    const rows = await provenanceRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("TXT");

    const { mock } = await import("@/lib/dns-providers/mock");
    const provider = mock.create({}, {}, "acc");
    const zone = { name: "example.com", id: "mock_zone_example.com" };
    const live = await provider.getRecords(zone);
    expect(live.some((record) => record.name === oldDkim.name)).toBe(false);
    expect(live.some((record) => record.type === "TXT" && record.name === NEW_ACCOUNT_TXT_NAME)).toBe(true);
  });

  it("the unscoped, all-rows cleanup would have offered both — scoping is what keeps the new account's record safe", async () => {
    await cutOver();
    const plan = await planDnsCleanup(caller(), fixture.domainId);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.every((step) => step.status === "removable")).toBe(true);
  });
});

describe("canceling a pending move", () => {
  it("leaves already-applied new-account records in place rather than reverting them", async () => {
    await applyOldThenStartAndApplyPending();

    await moveDomain(caller(), fixture.domainId, null);

    const domain = await domainRow();
    expect(domain.pendingProviderId).toBeNull();
    expect(domain.pendingDnsRecords).toEqual([]);
    // Sending never moved — the old account's records are still what's required.
    expect(domain.dnsRecords).toEqual([oldDkim]);

    // The new account's applied TXT record is untouched: still tracked, still live.
    const rows = await provenanceRows();
    expect(rows.some((row) => row.type === "TXT" && row.name === NEW_ACCOUNT_TXT_NAME)).toBe(true);

    const { mock } = await import("@/lib/dns-providers/mock");
    const provider = mock.create({}, {}, "acc");
    const zone = { name: "example.com", id: "mock_zone_example.com" };
    const live = await provider.getRecords(zone);
    expect(live.some((record) => record.type === "TXT" && record.name === NEW_ACCOUNT_TXT_NAME)).toBe(true);
  });
});
