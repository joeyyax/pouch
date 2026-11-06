import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { createDnsProviderAccount } from "@/lib/dns-providers/accounts";
import { addMockZone, resetMockZones } from "@/lib/dns-providers/mock";
import { planDomainDns } from "@/lib/domains/dns-plan";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

const dkim: ProposedDnsRecord = { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true };

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetMockZones();
  fixture = await seedFixture();
  await db.update(domains).set({ dnsRecords: [dkim] }).where(eq(domains.id, fixture.domainId));
});
afterEach(() => resetMockZones());

describe("planDomainDns", () => {
  it("reports no_account when the organization has no DNS provider account", async () => {
    const plan = await planDomainDns(fixture.organizationId, { name: "example.com", dnsRecords: [dkim] });
    expect(plan.status).toBe("no_account");
    expect(plan.steps).toEqual([]);
  });

  it("reports zone_not_found when the connected account has no zone for this domain", async () => {
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });
    const plan = await planDomainDns(fixture.organizationId, { name: "not-a-zone.test", dnsRecords: [dkim] });
    expect(plan.status).toBe("zone_not_found");
  });

  it("builds a ready plan against the live zone read through the provider's own API", async () => {
    addMockZone({ name: "example.com", id: "zone_example" }, []);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });

    const plan = await planDomainDns(fixture.organizationId, { name: "example.com", dnsRecords: [dkim] });
    expect(plan.status).toBe("ready");
    expect(plan.zoneName).toBe("example.com");
    expect(plan.steps).toEqual([expect.objectContaining({ verdict: "create" })]);
  });

  it("classifies an already-published record as already correct, not a create", async () => {
    addMockZone({ name: "example.com", id: "zone_example" }, [{ id: "rec_1", type: dkim.type, name: dkim.name, value: dkim.value }]);
    await createDnsProviderAccount(fixture.organizationId, { module: "mock", name: "primary", credentials: {} });

    const plan = await planDomainDns(fixture.organizationId, { name: "example.com", dnsRecords: [dkim] });
    expect(plan.steps).toEqual([expect.objectContaining({ verdict: "already_correct" })]);
  });
});
