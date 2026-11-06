import { afterEach, describe, expect, it, vi } from "vitest";
import { DnsNotSupportedError } from "@/lib/dns-providers/types";

/** Stands in for an AWS SDK command: carries its input and its class name. */
class FakeCommand {
  constructor(public readonly input: Record<string, unknown>) {}
}
function commands(names: string[]): Record<string, unknown> {
  return Object.fromEntries(names.map((name) => [name, { [name]: class extends FakeCommand {} }[name]]));
}

const route53Send = vi.fn();

vi.mock("@aws-sdk/client-route-53", () => ({
  Route53Client: class {
    constructor(public readonly config: Record<string, unknown>) {}
    send(command: FakeCommand) {
      return route53Send(command);
    }
  },
  ...commands([
    "ListHostedZonesCommand",
    "GetHostedZoneCommand",
    "ListResourceRecordSetsCommand",
    "ChangeResourceRecordSetsCommand",
  ]),
}));

const { buildDnsProvider } = await import("@/lib/dns-providers");

function named(command: FakeCommand): string {
  return command.constructor.name;
}

function awsError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

const CREDENTIALS = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" };

afterEach(() => {
  route53Send.mockReset();
});

describe("route53 credentials and settings", () => {
  it("rejects missing credentials", () => {
    expect(() => buildDnsProvider("route53", {})).toThrow();
  });

  it("accepts a bare account-scoped credential and one with a hostedZoneId setting", () => {
    expect(() => buildDnsProvider("route53", CREDENTIALS)).not.toThrow();
    expect(() => buildDnsProvider("route53", CREDENTIALS, { hostedZoneId: "Z123" })).not.toThrow();
  });
});

describe("route53 dns adapter", () => {
  it("declares apexCname false, unlike Cloudflare, since Route53 has no CNAME-at-apex flattening", async () => {
    const { dnsCapabilitiesOf } = await import("@/lib/dns-providers");
    expect(dnsCapabilitiesOf("route53")).toEqual({ apexCname: false, nsWritable: true, zoneEnumeration: true });
  });

  it("lists zones across pages for an account-scoped credential", async () => {
    route53Send.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "ListHostedZonesCommand" && !command.input.Marker) {
        return { HostedZones: [{ Id: "/hostedzone/Z1", Name: "one.test." }], IsTruncated: true, NextMarker: "m2" };
      }
      return { HostedZones: [{ Id: "/hostedzone/Z2", Name: "two.test." }], IsTruncated: false };
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    const zones = await provider.listZones();
    expect(zones).toEqual([
      { name: "one.test", id: "Z1" },
      { name: "two.test", id: "Z2" },
    ]);
  });

  it("refuses to list zones for a zone-scoped credential", async () => {
    const provider = buildDnsProvider("route53", CREDENTIALS, { hostedZoneId: "Z1" });
    await expect(provider.listZones()).rejects.toThrow(DnsNotSupportedError);
  });

  it("finds a zone by id for a zone-scoped credential without listing hosted zones", async () => {
    route53Send.mockImplementation(async (command: FakeCommand) => {
      expect(named(command)).toBe("GetHostedZoneCommand");
      return { HostedZone: { Id: "/hostedzone/Z1", Name: "example.org." } };
    });

    const provider = buildDnsProvider("route53", CREDENTIALS, { hostedZoneId: "Z1" });
    expect(await provider.findZone("example.org")).toEqual({ name: "example.org", id: "Z1" });
  });

  it("returns null from findZone when the configured zone id doesn't match the requested domain", async () => {
    route53Send.mockResolvedValue({ HostedZone: { Id: "/hostedzone/Z1", Name: "example.org." } });
    const provider = buildDnsProvider("route53", CREDENTIALS, { hostedZoneId: "Z1" });
    expect(await provider.findZone("someone-else.test")).toBeNull();
  });

  it("finds a zone by name for an account-scoped credential", async () => {
    route53Send.mockResolvedValue({ HostedZones: [{ Id: "/hostedzone/Z9", Name: "example.org." }], IsTruncated: false });
    const provider = buildDnsProvider("route53", CREDENTIALS);
    expect(await provider.findZone("example.org")).toEqual({ name: "example.org", id: "Z9" });
  });

  it("normalizes records to TXT, CNAME and MX, dropping types ObservedDnsRecord doesn't carry", async () => {
    route53Send.mockResolvedValue({
      ResourceRecordSets: [
        { Name: "example.org.", Type: "MX", ResourceRecords: [{ Value: "10 feedback-smtp.us-east-1.amazonses.com." }] },
        { Name: "example.org.", Type: "TXT", ResourceRecords: [{ Value: '"v=spf1 include:amazonses.com ~all"' }] },
        { Name: "example.org.", Type: "A", ResourceRecords: [{ Value: "192.0.2.1" }] },
        { Name: "old._domainkey.example.org.", Type: "CNAME", ResourceRecords: [{ Value: "old.dkim.example.net." }] },
      ],
      IsTruncated: false,
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    const records = await provider.getRecords({ name: "example.org", id: "Z9" });
    expect(records.map((record) => record.type).sort()).toEqual(["CNAME", "MX", "TXT"]);

    const mx = records.find((record) => record.type === "MX");
    expect(mx?.priority).toBe(10);
    expect(mx?.value).toBe("feedback-smtp.us-east-1.amazonses.com.");

    const txt = records.find((record) => record.type === "TXT");
    expect(txt?.value).toBe("v=spf1 include:amazonses.com ~all");
  });

  it("reassembles a TXT value split across Route53's 255-character quoted chunks", async () => {
    const long = "v=spf1 " + "include:a.example.net ".repeat(15) + "~all";
    const half = Math.ceil(long.length / 2);
    route53Send.mockResolvedValue({
      ResourceRecordSets: [
        {
          Name: "example.org.",
          Type: "TXT",
          ResourceRecords: [{ Value: `"${long.slice(0, half)}" "${long.slice(half)}"` }],
        },
      ],
      IsTruncated: false,
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    const [record] = await provider.getRecords({ name: "example.org", id: "Z9" });
    expect(record?.value).toBe(long);
  });

  it("gives every value in a multi-value record set the same synthesized id, unlike Cloudflare's per-record id", async () => {
    route53Send.mockResolvedValue({
      ResourceRecordSets: [
        {
          Name: "example.org.",
          Type: "MX",
          ResourceRecords: [{ Value: "10 mx1.example.net." }, { Value: "20 mx2.example.net." }],
        },
      ],
      IsTruncated: false,
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    const records = await provider.getRecords({ name: "example.org", id: "Z9" });
    expect(records).toHaveLength(2);
    expect(records[0]?.id).toBe(records[1]?.id);
    expect(records[0]?.id).toBe("MX:example.org");
  });

  it("reports ok from healthCheck via ListResourceRecordSets for a zone-scoped credential", async () => {
    route53Send.mockImplementation(async (command: FakeCommand) => {
      expect(named(command)).toBe("ListResourceRecordSetsCommand");
      expect(command.input.HostedZoneId).toBe("Z1");
      return { ResourceRecordSets: [] };
    });
    const provider = buildDnsProvider("route53", CREDENTIALS, { hostedZoneId: "Z1" });
    expect(await provider.healthCheck()).toEqual({ ok: true, detail: null });
  });

  it("reports ok from healthCheck via ListHostedZones for an account-scoped credential", async () => {
    route53Send.mockImplementation(async (command: FakeCommand) => {
      expect(named(command)).toBe("ListHostedZonesCommand");
      return { HostedZones: [] };
    });
    const provider = buildDnsProvider("route53", CREDENTIALS);
    expect(await provider.healthCheck()).toEqual({ ok: true, detail: null });
  });

  it("reports credentials rejected without throwing", async () => {
    route53Send.mockRejectedValue(awsError("AccessDeniedException"));
    const health = await buildDnsProvider("route53", CREDENTIALS).healthCheck();
    expect(health).toEqual({ ok: false, detail: "Credentials were rejected." });
  });

  it("reports rate limited on throttling", async () => {
    route53Send.mockRejectedValue(awsError("ThrottlingException"));
    const health = await buildDnsProvider("route53", CREDENTIALS).healthCheck();
    expect(health).toEqual({ ok: false, detail: "Rate limited by the provider." });
  });

  it("leaves removeRecords unimplemented, since deletion is #211", async () => {
    const provider = buildDnsProvider("route53", CREDENTIALS);
    await expect(provider.removeRecords({ name: "example.com", id: "Z1" }, [])).rejects.toThrow();
  });

  it("upserts a TXT record by replacing the whole record set with the quoted, chunked value", async () => {
    let sent: FakeCommand | null = null;
    route53Send.mockImplementation(async (command: FakeCommand) => {
      sent = command;
      return {};
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    const results = await provider.upsertRecords(
      { name: "example.com", id: "Z1" },
      [{ type: "TXT", name: "example.com", value: "v=spf1 include:mail.example.net ~all", required: true, merge: "spf" }],
    );

    expect(results).toEqual([{ name: "example.com", type: "TXT", status: "applied" }]);
    expect(named(sent!)).toBe("ChangeResourceRecordSetsCommand");
    const input = sent!.input as { HostedZoneId: string; ChangeBatch: { Changes: { Action: string; ResourceRecordSet: { Name: string; Type: string; ResourceRecords: { Value: string }[] } }[] } };
    expect(input.HostedZoneId).toBe("Z1");
    const change = input.ChangeBatch.Changes[0]!;
    expect(change.Action).toBe("UPSERT");
    expect(change.ResourceRecordSet.ResourceRecords[0]?.Value).toBe('"v=spf1 include:mail.example.net ~all"');
  });

  it("upserts an MX record with priority folded back into the rdata", async () => {
    let sent: FakeCommand | null = null;
    route53Send.mockImplementation(async (command: FakeCommand) => {
      sent = command;
      return {};
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    await provider.upsertRecords({ name: "example.com", id: "Z1" }, [
      { type: "MX", name: "mail.example.com", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false },
    ]);

    const input = sent!.input as { ChangeBatch: { Changes: { ResourceRecordSet: { ResourceRecords: { Value: string }[] } }[] } };
    expect(input.ChangeBatch.Changes[0]!.ResourceRecordSet.ResourceRecords[0]?.Value).toBe("10 feedback-smtp.us-west-2.amazonses.com");
  });

  it("refuses to upsert into a record set that already holds more than one value", async () => {
    route53Send.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "ListResourceRecordSetsCommand") {
        return {
          ResourceRecordSets: [
            { Name: "example.com.", Type: "MX", ResourceRecords: [{ Value: "10 mx1.example.net." }, { Value: "20 mx2.example.net." }] },
          ],
        };
      }
      throw new Error("ChangeResourceRecordSets should never be called when the set already holds more than one value.");
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    const results = await provider.upsertRecords({ name: "example.com", id: "Z1" }, [
      { type: "MX", name: "example.com", value: "mx3.example.net", priority: 30, required: true },
    ]);

    expect(results).toEqual([
      { name: "example.com", type: "MX", status: "failed", error: expect.stringContaining("More than one MX value already exists") },
    ]);
  });

  it("proceeds with the upsert when the pre-check finds an unrelated record set at a different name or type", async () => {
    let changeSent = false;
    route53Send.mockImplementation(async (command: FakeCommand) => {
      if (named(command) === "ListResourceRecordSetsCommand") {
        return { ResourceRecordSets: [{ Name: "other.example.com.", Type: "TXT", ResourceRecords: [{ Value: '"unrelated"' }] }] };
      }
      changeSent = true;
      return {};
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    const results = await provider.upsertRecords({ name: "example.com", id: "Z1" }, [
      { type: "CNAME", name: "ok._domainkey.example.com", value: "ok.dkim.amazonses.com", required: true },
    ]);

    expect(changeSent).toBe(true);
    expect(results).toEqual([{ name: "ok._domainkey.example.com", type: "CNAME", status: "applied" }]);
  });

  it("fails one record without stopping the rest of the batch", async () => {
    route53Send.mockImplementation(async (command: FakeCommand) => {
      const input = command.input as { ChangeBatch?: { Changes: { ResourceRecordSet: { Name: string } }[] } };
      if (input.ChangeBatch?.Changes[0]?.ResourceRecordSet.Name === "fails.example.com") {
        throw awsError("InvalidChangeBatch");
      }
      return {};
    });

    const provider = buildDnsProvider("route53", CREDENTIALS);
    const results = await provider.upsertRecords({ name: "example.com", id: "Z1" }, [
      { type: "TXT", name: "fails.example.com", value: "v=spf1 ~all", required: true },
      { type: "CNAME", name: "ok._domainkey.example.com", value: "ok.dkim.amazonses.com", required: true },
    ]);

    expect(results).toEqual([
      { name: "fails.example.com", type: "TXT", status: "failed", error: "InvalidChangeBatch" },
      { name: "ok._domainkey.example.com", type: "CNAME", status: "applied" },
    ]);
  });
});
