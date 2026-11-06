import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { dnsProviderRecords, domains } from "@/lib/db/schema";
import { userActor } from "@/lib/activity/record";
import { createDnsProviderAccount } from "@/lib/dns-providers/accounts";
import { addMockZone, resetMockZones } from "@/lib/dns-providers/mock";
import { applyDnsPlan } from "@/lib/domains/dns-apply";
import { planDnsCleanup, removeDnsProvenance } from "@/lib/domains/dns-cleanup";
import type { DomainCaller } from "@/lib/domains";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

const dkim: ProposedDnsRecord = { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true };
const mx: ProposedDnsRecord = { type: "MX", name: "example.com", value: "feedback-smtp.us-east-1.amazonses.com", priority: 10, required: true };
const spf: ProposedDnsRecord = { type: "TXT", name: "example.com", value: "v=spf1 include:amazonses.com ~all", required: true, merge: "spf" };

let fixture: Fixture;

function caller(organizationId: string): DomainCaller {
  return { organizationId, domainIds: [] as string[], actor: userActor("u_test", "Test") };
}

async function setRequired(records: ProposedDnsRecord[]) {
  await db.update(domains).set({ dnsRecords: records }).where(eq(domains.id, fixture.domainId));
}

beforeEach(async () => {
  await resetDatabase();
  resetMockZones();
  fixture = await seedFixture();
  addMockZone({ name: "example.com", id: "mock_zone_example.com" }, []);
});
afterEach(() => {
  resetMockZones();
});

describe("removeDnsProvenance", () => {
  it("deletes a plain record whose live value still matches what Pouch wrote, and drops its provenance", async () => {
    await setRequired([dkim]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });
    await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);

    const result = await removeDnsProvenance(caller(fixture.organizationId), fixture.domainId);
    expect(result.steps).toEqual([expect.objectContaining({ action: "delete", outcome: "removed" })]);

    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(0);

    const plan = await planDnsCleanup(caller(fixture.organizationId), fixture.domainId);
    expect(plan.steps).toEqual([]);
  });

  it("refuses a record that's been hand-edited since Pouch wrote it, leaves it live, and keeps its provenance", async () => {
    await setRequired([dkim]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });
    await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);

    // A hand edit at the provider — the same record id and name, a value Pouch never wrote.
    const live = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(live).toHaveLength(1);
    addMockZone({ name: "example.com", id: "mock_zone_example.com" }, [
      { id: "rec_hand_edited", type: "CNAME", name: dkim.name, value: "hand-edited-value.example.net" },
    ]);

    const plan = await planDnsCleanup(caller(fixture.organizationId), fixture.domainId);
    expect(plan.steps).toEqual([expect.objectContaining({ status: "refused" })]);

    const result = await removeDnsProvenance(caller(fixture.organizationId), fixture.domainId);
    expect(result.steps).toEqual([expect.objectContaining({ outcome: "refused" })]);

    // Nothing was deleted at the provider, and the provenance row is untouched.
    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(1);
  });

  it("refuses a record that's no longer published at all", async () => {
    await setRequired([dkim]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });
    await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);

    // Cleared out from under us — same as someone deleting the record by hand.
    addMockZone({ name: "example.com", id: "mock_zone_example.com" }, []);

    const result = await removeDnsProvenance(caller(fixture.organizationId), fixture.domainId);
    expect(result.steps).toEqual([expect.objectContaining({ outcome: "refused" })]);

    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(1);
  });

  it("edits a merged SPF record to remove only Pouch's mechanisms, and drops its provenance", async () => {
    addMockZone({ name: "example.com", id: "mock_zone_example.com" }, [
      { id: "rec_spf", type: "TXT", name: "example.com", value: "v=spf1 include:mailer.example.net ~all" },
    ]);
    await setRequired([spf]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });
    await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);

    const result = await removeDnsProvenance(caller(fixture.organizationId), fixture.domainId);
    expect(result.steps).toEqual([expect.objectContaining({ action: "edit", outcome: "removed" })]);

    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(0);

    // The other provider's mechanism is still published — never deleted, only edited.
    const { mock } = await import("@/lib/dns-providers/mock");
    const provider = mock.create({}, {}, "acc");
    const zone = { name: "example.com", id: "mock_zone_example.com" };
    const live = await provider.getRecords(zone, "example.com");
    expect(live).toEqual([expect.objectContaining({ value: "v=spf1 include:mailer.example.net ~all" })]);
  });

  it("refuses an MX record whose priority no longer matches what the domain currently requires", async () => {
    await setRequired([mx]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });
    await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);

    // The domain's required priority changed since the record was written.
    await setRequired([{ ...mx, priority: 20 }]);

    const result = await removeDnsProvenance(caller(fixture.organizationId), fixture.domainId);
    expect(result.steps).toEqual([expect.objectContaining({ outcome: "refused" })]);

    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(1);
  });

  it("is a no-op with no rows when the domain has no provenance — never even asks for a DNS provider account", async () => {
    // No account connected at all: if this reached resolveDnsZoneContext it would come back
    // no_account, not ready. Nothing to clean up means nothing to resolve.
    const result = await removeDnsProvenance(caller(fixture.organizationId), fixture.domainId);
    expect(result).toEqual({ status: "ready", zoneName: null, steps: [], detail: null });
  });
});

describe("previous_account scoping with a mixed set of pre- and post-#239 rows", () => {
  it("scopes a column-carrying row directly and falls back to the required-set inference for a legacy null row", async () => {
    await setRequired([dkim, mx]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });
    await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);

    // A pre-#239 row: written before the column existed, so provider_id is null. Its
    // (type, name) isn't in the domain's required set, the same shape a leftover from a
    // completed cutover would have — this is what still has to fall back to `isCurrentlyRequired`.
    await db.insert(dnsProviderRecords).values({
      id: "dpr_legacy",
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      dnsProviderAccountId: (await db.select().from(dnsProviderRecords).limit(1))[0]!.dnsProviderAccountId,
      providerId: null,
      zoneName: "example.com",
      type: "CNAME",
      name: "leftover._domainkey.example.com",
      writtenValue: "leftover.oldprovider.example.net",
      appliedAt: new Date(),
    });

    const plan = await planDnsCleanup(caller(fixture.organizationId), fixture.domainId, "previous_account");

    // The dkim/mx rows carry the current account's id directly, so they're excluded on sight —
    // no inference needed, and no risk of a required-set coincidence misreading them as stale.
    expect(plan.steps.some((step) => step.name === dkim.name)).toBe(false);
    expect(plan.steps.some((step) => step.name === mx.name)).toBe(false);

    // The legacy row has no column to check, so it falls back to the pre-#239 inference, which
    // correctly reads "not in today's required set" as the previous account's leftover.
    expect(plan.steps).toEqual([expect.objectContaining({ name: "leftover._domainkey.example.com" })]);
  });
});
