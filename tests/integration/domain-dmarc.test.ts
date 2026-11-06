import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { GET as read, PATCH as patch } from "@/app/api/v1/domains/[id]/route";
import { POST as verify } from "@/app/api/v1/domains/[id]/verify/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { resetDnsCheckCache } from "@/lib/domains/dns-check";
import type { SerializedDomain } from "@/lib/domains";
import { apiRequest, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

const zone = vi.hoisted(() => new Map<string, string[]>());
vi.mock("node:dns/promises", () => {
  class Resolver {
    setServers() {}
    cancel() {}
    async resolveTxt(name: string): Promise<string[][]> {
      const records = zone.get(name);
      if (records?.[0] === "timeout") throw Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
      if (!records) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return records.map((record) => [record]);
    }
  }
  return { Resolver };
});

let fixture: Fixture;

const request = (path = "", method = "GET", body?: unknown): Request => apiRequest(fixture.secret, `/v1/domains/${fixture.domainId}${path}`, method, body);

beforeEach(async () => {
  zone.clear();
  resetDnsCheckCache();
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
  await db
    .update(domains)
    .set({
      status: "pending",
      verifiedAt: null,
      dnsRecords: [
        { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true },
        { type: "TXT", name: "mail.example.com", value: "v=spf1 include:amazonses.com ~all", required: false },
      ],
    })
    .where(eq(domains.id, fixture.domainId));
});

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("a domain's DMARC record", () => {
  it("is recommended in dns_records as optional, and left out of the default read", async () => {
    const response = await read(request(), routeContext(fixture.domainId));
    const domain = await body<SerializedDomain>(response);

    expect(domain.dns_records.at(-1)).toEqual({ type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=none;", required: false });
    expect(domain.dmarc).toBeUndefined();
  });

  it("reads live on include=dmarc: policy and report addresses", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none; rua=mailto:reports@example.com"]);
    const response = await read(request("?include=dmarc"), routeContext(fixture.domainId));
    const domain = await body<SerializedDomain>(response);

    expect(domain.dmarc).toMatchObject({ status: "found", policy: "none", rua: ["mailto:reports@example.com"] });
    expect(domain.dmarc?.findings.map((finding) => finding.kind)).toEqual(["monitoring_only"]);
  });

  it("never blocks verification: a verified domain with no record still verifies, and reports it missing", async () => {
    const response = await verify(request("/verify", "POST"), routeContext(fixture.domainId));
    const domain = await body<SerializedDomain>(response);

    expect(response.status).toBe(200);
    expect(domain.status).toBe("verified");
    expect(domain.errors).toEqual([]);
    expect(domain.missing_records).toEqual([]);
    expect(domain.dmarc).toMatchObject({ status: "missing", findings: [expect.objectContaining({ kind: "missing", severity: "problem" })] });
  });

  it("flags two records on a verify call", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none", "v=DMARC1; p=reject"]);
    const domain = await body<SerializedDomain>(await verify(request("/verify", "POST"), routeContext(fixture.domainId)));
    expect(domain.status).toBe("verified");
    expect(domain.dmarc?.status).toBe("multiple");
  });
});

describe("turning bulk_allowed on", () => {
  const turnOn = () => patch(request("", "PATCH", { bulk_allowed: true }), routeContext(fixture.domainId));
  const stored = async () => (await db.select({ bulkAllowed: domains.bulkAllowed }).from(domains).where(eq(domains.id, fixture.domainId)))[0]?.bulkAllowed;

  it("is refused with no DMARC record, naming the record to publish", async () => {
    const response = await turnOn();
    const error = await body<{ error: { code: string; message: string; detail: { reason: string } } }>(response);

    expect(response.status).toBe(422);
    expect(error.error).toMatchObject({ code: "bulk_not_allowed", detail: { reason: "dmarc_required" } });
    expect(error.error.message).toContain("_dmarc.example.com");
    expect(await stored()).toBe(false);
  });

  it("is refused with more than one record", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none", "v=DMARC1; p=reject"]);
    expect((await turnOn()).status).toBe(422);
    expect(await stored()).toBe(false);
  });

  it("is accepted with a p=none record", async () => {
    zone.set("_dmarc.example.com", ["v=DMARC1; p=none;"]);
    expect((await turnOn()).status).toBe(200);
    expect(await stored()).toBe(true);
  });

  it("is accepted when the lookup can't answer, rather than refusing on a timeout", async () => {
    zone.set("_dmarc.example.com", ["timeout"]);
    expect((await turnOn()).status).toBe(200);
  });

  it("isn't re-checked for a domain already on, and turning it off is always accepted", async () => {
    await db.update(domains).set({ bulkAllowed: true }).where(eq(domains.id, fixture.domainId));
    expect((await turnOn()).status).toBe(200);
    const off = await patch(request("", "PATCH", { bulk_allowed: false }), routeContext(fixture.domainId));
    expect(off.status).toBe(200);
    expect(await stored()).toBe(false);
  });
});
