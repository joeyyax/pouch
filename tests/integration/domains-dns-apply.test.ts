import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { dnsProviderRecords, domains } from "@/lib/db/schema";
import { userActor } from "@/lib/activity/record";
import * as dnsAccountsModule from "@/lib/dns-providers/accounts";
import { createDnsProviderAccount } from "@/lib/dns-providers/accounts";
import { addMockZone, resetMockZones } from "@/lib/dns-providers/mock";
import { applyDnsPlan } from "@/lib/domains/dns-apply";
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
  vi.restoreAllMocks();
  resetMockZones();
});

describe("applyDnsPlan", () => {
  it("reports no_account when the organization has no DNS provider account", async () => {
    await setRequired([dkim]);
    const result = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(result.status).toBe("no_account");
    expect(result.steps).toEqual([]);
  });

  it("creates missing records and records provenance for each", async () => {
    await setRequired([dkim, mx]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });

    const result = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(result.status).toBe("ready");
    expect(result.steps).toEqual([
      expect.objectContaining({ status: "applied" }),
      expect.objectContaining({ status: "applied" }),
    ]);

    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(2);
    const dkimRow = rows.find((row) => row.type === "CNAME");
    expect(dkimRow?.writtenValue).toBe(dkim.value);
    expect(dkimRow?.zoneName).toBe("example.com");
    expect(dkimRow?.organizationId).toBe(fixture.organizationId);
    expect(dkimRow?.dnsProviderAccountId).toBeTruthy();
    expect(dkimRow?.appliedAt).toBeInstanceOf(Date);
    // Every row applied against the domain's current binding carries that email account's id —
    // #239 — so a later reader can scope "previous account" without inferring it.
    expect(rows.every((row) => row.providerId === fixture.providerId)).toBe(true);
  });

  it("is idempotent: applying twice writes nothing new the second time", async () => {
    await setRequired([dkim]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });

    const first = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(first.steps).toEqual([expect.objectContaining({ status: "applied" })]);

    const second = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(second.steps).toEqual([expect.objectContaining({ status: "skipped" })]);

    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(1);
  });

  it("merges only the missing SPF mechanisms, and records only what it added as provenance", async () => {
    addMockZone({ name: "example.com", id: "mock_zone_example.com" }, [
      { id: "rec_spf", type: "TXT", name: "example.com", value: "v=spf1 include:mailer.example.net ~all" },
    ]);
    await setRequired([spf]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });

    const result = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(result.steps).toEqual([expect.objectContaining({ status: "applied" })]);

    const [row] = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(row?.writtenValue).toBe("include:amazonses.com");

    // Applying again is a no-op — the mechanism it added last time already reads as published.
    const retry = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(retry.steps).toEqual([expect.objectContaining({ status: "skipped" })]);
    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(1);
  });

  it("never writes a conflict, on the first run or a retry", async () => {
    addMockZone({ name: "example.com", id: "mock_zone_example.com" }, [
      { id: "rec_other", type: "CNAME", name: dkim.name, value: "someone-elses-value.example.net" },
    ]);
    await setRequired([dkim]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });

    const first = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(first.steps).toEqual([expect.objectContaining({ status: "conflict" })]);

    const retry = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(retry.steps).toEqual([expect.objectContaining({ status: "conflict" })]);

    const rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(0);
  });

  it("a partial failure leaves earlier writes applied, reports the failure, and a retry picks up only what's outstanding", async () => {
    await setRequired([dkim, mx]);
    const account = await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });

    const real = dnsAccountsModule.dnsProviderFor;
    let attempt = 0;
    const spy = vi.spyOn(dnsAccountsModule, "dnsProviderFor").mockImplementation((row) => {
      const provider = real(row);
      return {
        ...provider,
        async upsertRecords(zone, records) {
          attempt += 1;
          // The MX record's write fails on the first pass only — a stand-in for a transient
          // provider error (rate limit, timeout), not a conflict: the plan already says this
          // record is safe to write, the provider call itself is what fails.
          if (attempt === 2 && records[0]?.type === "MX") {
            return [{ name: records[0].name, type: records[0].type, status: "failed", error: "rate limited by mock" }];
          }
          return provider.upsertRecords(zone, records);
        },
      };
    });

    const first = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(first.steps).toEqual([
      expect.objectContaining({ status: "applied", record: expect.objectContaining({ type: "CNAME" }) }),
      expect.objectContaining({ status: "failed", record: expect.objectContaining({ type: "MX" }), error: "rate limited by mock" },
      ),
    ]);

    let rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("CNAME");

    // Retry: the CNAME is already correct now (a no-op), and the MX write goes through since
    // the mock stops failing after the first attempt.
    const retry = await applyDnsPlan(caller(fixture.organizationId), fixture.domainId);
    expect(retry.steps).toEqual([
      expect.objectContaining({ status: "skipped", record: expect.objectContaining({ type: "CNAME" }) }),
      expect.objectContaining({ status: "applied", record: expect.objectContaining({ type: "MX" }) }),
    ]);

    rows = await db.select().from(dnsProviderRecords).where(eq(dnsProviderRecords.domainId, fixture.domainId));
    expect(rows).toHaveLength(2);

    spy.mockRestore();
    void account;
  });
});
