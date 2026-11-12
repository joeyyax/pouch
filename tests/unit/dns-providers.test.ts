import { afterEach, describe, expect, it, vi } from "vitest";
import { txtText } from "@/lib/dns-providers/txt";
import { DNS_PROVIDER_MODULES, buildDnsProvider, dnsCapabilitiesOf, dnsCredentialsSchemaOf, dnsSettingsSchemaOf } from "@/lib/dns-providers";
import { addMockZone, mock, resetMockZones } from "@/lib/dns-providers/mock";
import { DnsNotSupportedError } from "@/lib/dns-providers/types";

afterEach(() => {
  vi.unstubAllGlobals();
  resetMockZones();
});

describe("txtText", () => {
  it("joins quoted chunks", () => {
    expect(txtText('"v=DKIM1; p=abc" "def"')).toBe("v=DKIM1; p=abcdef");
  });

  it("unescapes quotes inside a chunk", () => {
    expect(txtText('"say \\"hi\\""')).toBe('say "hi"');
  });

  it("leaves an unquoted value alone", () => {
    expect(txtText("v=spf1 ~all")).toBe("v=spf1 ~all");
  });
});

describe("dns provider registry", () => {
  it("registers cloudflare and route53 alongside mock", () => {
    expect(DNS_PROVIDER_MODULES.sort()).toEqual(["cloudflare", "mock", "route53"]);
  });

  it("gives every module a credentials schema", () => {
    for (const dnsModule of DNS_PROVIDER_MODULES) {
      expect(dnsCredentialsSchemaOf(dnsModule)).toBeTruthy();
    }
    expect(() => dnsCredentialsSchemaOf("carrier-pigeon")).toThrow(/carrier-pigeon/);
  });

  it("gives every module a settings schema that accepts an empty object", () => {
    for (const dnsModule of DNS_PROVIDER_MODULES) {
      expect(dnsSettingsSchemaOf(dnsModule).safeParse({}).success, dnsModule).toBe(true);
    }
  });

  it("declares capabilities per module without needing credentials", () => {
    expect(dnsCapabilitiesOf("cloudflare")).toEqual({ apexCname: true, nsWritable: false, zoneEnumeration: true });
    expect(dnsCapabilitiesOf("mock")).toEqual({ apexCname: true, nsWritable: false, zoneEnumeration: true });
    expect(dnsCapabilitiesOf("route53")).toEqual({ apexCname: false, nsWritable: true, zoneEnumeration: true });
    expect(() => dnsCapabilitiesOf("carrier-pigeon")).toThrow(/carrier-pigeon/);
  });

  it("refuses an unknown module rather than building nowhere", () => {
    expect(() => buildDnsProvider("carrier-pigeon", {})).toThrow(/carrier-pigeon/);
  });
});

describe("mock dns adapter", () => {
  it("lists and finds a fixture zone by name, never by provider id", async () => {
    const provider = buildDnsProvider("mock", {});
    const zones = await provider.listZones();
    expect(zones.some((zone) => zone.name === "example.com")).toBe(true);

    const zone = await provider.findZone("example.com");
    expect(zone).toEqual({ name: "example.com", id: "mock_zone_example.com" });
    expect(await provider.findZone("nowhere.test")).toBeNull();
  });

  it("creates a record that doesn't exist yet", async () => {
    addMockZone({ name: "fixture.test", id: "mock_zone_fixture.test" }, []);
    const provider = mock.create({}, {}, "acct");
    const zone = { name: "fixture.test", id: "mock_zone_fixture.test" };

    const results = await provider.upsertRecords(zone, [
      { type: "TXT", name: "fixture.test", value: "v=spf1 ~all", required: true },
    ]);
    expect(results).toEqual([{ name: "fixture.test", type: "TXT", status: "applied" }]);

    const records = await provider.getRecords(zone, "fixture.test");
    expect(records).toEqual([expect.objectContaining({ type: "TXT", name: "fixture.test", value: "v=spf1 ~all" })]);
  });

});

function cloudflareResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("cloudflare credentials", () => {
  it("rejects an empty object", () => {
    expect(dnsCredentialsSchemaOf("cloudflare").safeParse({}).success).toBe(false);
  });

  it("accepts a bare token for an account-scoped credential, and a token with zoneId for a zone-scoped one", () => {
    expect(dnsCredentialsSchemaOf("cloudflare").safeParse({ token: "a".repeat(40) }).success).toBe(true);
    expect(dnsCredentialsSchemaOf("cloudflare").safeParse({ token: "a".repeat(40), zoneId: "zone123" }).success).toBe(true);
  });

  it("rejects a token shaped like a Cloudflare Global API Key", () => {
    const globalKeyShaped = "0123456789abcdef0123456789abcdef01234";
    const result = dnsCredentialsSchemaOf("cloudflare").safeParse({ token: globalKeyShaped.slice(0, 37) });
    expect(result.success).toBe(false);
  });

});

describe("cloudflare dns adapter", () => {
  it("lists zones across pages for an account-scoped token", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      calls.push(url.pathname + url.search);
      const page = url.searchParams.get("page");
      if (page === "1") {
        return cloudflareResponse({
          success: true,
          errors: [],
          result: [{ id: "z1", name: "one.test", status: "active" }],
          result_info: { page: 1, per_page: 50, total_pages: 2, total_count: 2 },
        });
      }
      return cloudflareResponse({
        success: true,
        errors: [],
        result: [{ id: "z2", name: "two.test", status: "active" }],
        result_info: { page: 2, per_page: 50, total_pages: 2, total_count: 2 },
      });
    });

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    const zones = await provider.listZones();
    expect(zones).toEqual([
      { name: "one.test", id: "z1" },
      { name: "two.test", id: "z2" },
    ]);
    expect(calls.every((call) => call.startsWith("/client/v4/zones"))).toBe(true);
  });

  it("refuses to list zones for a zone-scoped credential", async () => {
    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40), zoneId: "zone123" });
    await expect(provider.listZones()).rejects.toThrow(DnsNotSupportedError);
  });

  it("finds a zone by id for a zone-scoped credential without calling the zones-list endpoint", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/client/v4/zones/zone123");
      return cloudflareResponse({ success: true, errors: [], result: { id: "zone123", name: "example.org", status: "active" } });
    });

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40), zoneId: "zone123" });
    const zone = await provider.findZone("example.org");
    expect(zone).toEqual({ name: "example.org", id: "zone123" });
  });

  it("returns null from findZone when the configured zone id doesn't match the requested domain", async () => {
    vi.stubGlobal("fetch", async () =>
      cloudflareResponse({ success: true, errors: [], result: { id: "zone123", name: "example.org", status: "active" } }),
    );
    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40), zoneId: "zone123" });
    expect(await provider.findZone("someone-else.test")).toBeNull();
  });

  it("finds a zone by name for an account-scoped credential", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      expect(url.searchParams.get("name")).toBe("example.org");
      return cloudflareResponse({
        success: true,
        errors: [],
        result: [{ id: "z9", name: "example.org", status: "active" }],
        result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 1 },
      });
    });

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    expect(await provider.findZone("example.org")).toEqual({ name: "example.org", id: "z9" });
  });

  it("normalizes records to TXT, CNAME and MX, dropping types ObservedDnsRecord doesn't carry, and carries the record id", async () => {
    vi.stubGlobal("fetch", async () =>
      cloudflareResponse({
        success: true,
        errors: [],
        result: [
          { id: "cf_mx1", type: "MX", name: "example.org", content: "feedback-smtp.us-east-1.amazonses.com", priority: 10 },
          { id: "cf_txt1", type: "TXT", name: "example.org", content: '"v=spf1 include:" "amazonses.com ~all"' },
          { id: "cf_a1", type: "A", name: "example.org", content: "192.0.2.1" },
          { id: "cf_cname1", type: "CNAME", name: "old._domainkey.example.org", content: "old.dkim.example.net" },
        ],
        result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 4 },
      }),
    );

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    const records = await provider.getRecords({ name: "example.org", id: "z9" });
    expect(records.map((record) => record.type).sort()).toEqual(["CNAME", "MX", "TXT"]);
    const mx = records.find((record) => record.type === "MX");
    expect(mx?.priority).toBe(10);
    expect(mx?.id).toBe("cf_mx1");
    expect(mx).not.toHaveProperty("required");
    expect(records.find((record) => record.type === "TXT")?.value).toBe("v=spf1 include:amazonses.com ~all");
  });

  it("reports ok from healthCheck through the token verification endpoint", async () => {
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/client/v4/user/tokens/verify");
      return cloudflareResponse({ success: true, errors: [], result: { id: "t1", status: "active" } });
    });
    expect(await buildDnsProvider("cloudflare", { token: "a".repeat(40) }).healthCheck()).toEqual({ ok: true, detail: null });
  });

  it("reports credentials rejected on a 401, without throwing", async () => {
    vi.stubGlobal("fetch", async () => cloudflareResponse({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, 401));
    const health = await buildDnsProvider("cloudflare", { token: "a".repeat(40) }).healthCheck();
    expect(health).toEqual({ ok: false, detail: "Credentials were rejected." });
  });

  it("reports rate limited on a 429", async () => {
    vi.stubGlobal("fetch", async () => cloudflareResponse({ success: false, errors: [{ code: 10000, message: "rate limited" }] }, 429));
    const health = await buildDnsProvider("cloudflare", { token: "a".repeat(40) }).healthCheck();
    expect(health).toEqual({ ok: false, detail: "Rate limited by the provider." });
  });

  it("deletes the one record matched by type and name", async () => {
    const requests: { method: string; path: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname });
      if (method === "GET") {
        return cloudflareResponse({
          success: true,
          errors: [],
          result: [{ id: "cf_1", type: "CNAME", name: "abc._domainkey.example.com", content: "abc.dkim.amazonses.com" }],
          result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 1 },
        });
      }
      return cloudflareResponse({ success: true, errors: [], result: {} });
    });

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    const zone = { name: "example.com", id: "z1" };
    await provider.removeRecords(zone, [{ type: "CNAME", name: "abc._domainkey.example.com" }]);

    const deletion = requests.find((call) => call.method === "DELETE");
    expect(deletion?.path).toBe("/client/v4/zones/z1/dns_records/cf_1");
  });

  it("is a no-op when nothing is published at that name", async () => {
    const requests: { method: string }[] = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      requests.push({ method: init?.method ?? "GET" });
      return cloudflareResponse({ success: true, errors: [], result: [], result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 0 } });
    });

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    const zone = { name: "example.com", id: "z1" };
    await provider.removeRecords(zone, [{ type: "TXT", name: "example.com" }]);

    expect(requests.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses to guess when more than one record sits at the name to delete", async () => {
    vi.stubGlobal("fetch", async () =>
      cloudflareResponse({
        success: true,
        errors: [],
        result: [
          { id: "cf_1", type: "TXT", name: "example.com", content: "v=spf1 ~all" },
          { id: "cf_2", type: "TXT", name: "example.com", content: "v=spf1 include:other.example ~all" },
        ],
        result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 2 },
      }),
    );

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    const zone = { name: "example.com", id: "z1" };
    await expect(provider.removeRecords(zone, [{ type: "TXT", name: "example.com" }])).rejects.toThrow();
  });

  it("creates a record DNS-only when nothing exists at the name, never proxied", async () => {
    const requests: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname, body: init?.body ? JSON.parse(init.body as string) : null });
      if (method === "GET") {
        return cloudflareResponse({ success: true, errors: [], result: [], result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 0 } });
      }
      return cloudflareResponse({ success: true, errors: [], result: { id: "new1", type: "CNAME", name: "abc._domainkey.example.com", content: "abc.dkim.amazonses.com" } });
    });

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    const zone = { name: "example.com", id: "z1" };
    const results = await provider.upsertRecords(zone, [
      { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true },
    ]);

    expect(results).toEqual([{ name: "abc._domainkey.example.com", type: "CNAME", status: "applied" }]);
    const write = requests.find((call) => call.method === "POST");
    expect(write?.path).toBe("/client/v4/zones/z1/dns_records");
    expect(write?.body).toMatchObject({ type: "CNAME", content: "abc.dkim.amazonses.com", proxied: false });
  });

  it("updates the existing record by id (PATCH) rather than creating a second one", async () => {
    const requests: { method: string; path: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname });
      if (method === "GET") {
        return cloudflareResponse({
          success: true,
          errors: [],
          result: [{ id: "rec_existing", type: "TXT", name: "example.com", content: "v=spf1 ~all" }],
          result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 1 },
        });
      }
      return cloudflareResponse({ success: true, errors: [], result: { id: "rec_existing", type: "TXT", name: "example.com", content: "v=spf1 include:mail.example.net ~all" } });
    });

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    const zone = { name: "example.com", id: "z1" };
    const results = await provider.upsertRecords(zone, [
      { type: "TXT", name: "example.com", value: "v=spf1 include:mail.example.net ~all", required: true, merge: "spf" },
    ]);

    expect(results).toEqual([{ name: "example.com", type: "TXT", status: "applied" }]);
    const write = requests.find((call) => call.method === "PATCH");
    expect(write?.path).toBe("/client/v4/zones/z1/dns_records/rec_existing");
  });

  it("fails one record without stopping the rest of the batch", async () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.searchParams.get("name") === "fails.example.com") {
        return cloudflareResponse({
          success: true,
          errors: [],
          result: [
            { id: "r1", type: "TXT", name: "fails.example.com", content: "one" },
            { id: "r2", type: "TXT", name: "fails.example.com", content: "two" },
          ],
          result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 2 },
        });
      }
      if (method === "GET") {
        return cloudflareResponse({ success: true, errors: [], result: [], result_info: { page: 1, per_page: 50, total_pages: 1, total_count: 0 } });
      }
      return cloudflareResponse({ success: true, errors: [], result: { id: "new1" } });
    });

    const provider = buildDnsProvider("cloudflare", { token: "a".repeat(40) });
    const zone = { name: "example.com", id: "z1" };
    const results = await provider.upsertRecords(zone, [
      { type: "TXT", name: "fails.example.com", value: "v=spf1 ~all", required: true },
      { type: "CNAME", name: "ok._domainkey.example.com", value: "ok.dkim.amazonses.com", required: true },
    ]);

    expect(results).toEqual([
      { name: "fails.example.com", type: "TXT", status: "failed", error: expect.stringContaining("More than one") },
      { name: "ok._domainkey.example.com", type: "CNAME", status: "applied" },
    ]);
  });
});
