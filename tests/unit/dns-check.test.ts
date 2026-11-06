import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProposedDnsRecord } from "@/lib/providers/adapters/types";

type QueuedResult = { value: unknown } | { error: Error };

const queue: QueuedResult[] = [];
const cancelCalls: number[] = [];

function queueValue(value: unknown) {
  queue.push({ value });
}

function queueError(code: string) {
  queue.push({ error: Object.assign(new Error(code), { code }) });
}

vi.mock("node:dns/promises", () => {
  class MockResolver {
    cancel() {
      cancelCalls.push(1);
    }
    setServers() {
      // Fixed public resolvers in the real implementation; irrelevant to these tests.
    }
    private async next(): Promise<unknown> {
      const next = queue.shift();
      if (!next) throw new Error("no queued DNS response");
      if ("error" in next) throw next.error;
      return next.value;
    }
    async resolveCname(): Promise<string[]> {
      return this.next() as Promise<string[]>;
    }
    async resolveMx(): Promise<{ priority: number; exchange: string }[]> {
      return this.next() as Promise<{ priority: number; exchange: string }[]>;
    }
    async resolveTxt(): Promise<string[][]> {
      return this.next() as Promise<string[][]>;
    }
  }
  return { Resolver: MockResolver };
});

const { checkRecord, checkRecords, resetDnsCheckCache } = await import("@/lib/domains/dns-check");

const cname: ProposedDnsRecord = { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com", required: true };
const mx: ProposedDnsRecord = { type: "MX", name: "mail.example.com", value: "feedback-smtp.us-west-2.amazonses.com", priority: 10, required: false };
const txt: ProposedDnsRecord = { type: "TXT", name: "mail.example.com", value: "v=spf1 include:amazonses.com ~all", required: false };

beforeEach(() => {
  queue.length = 0;
  cancelCalls.length = 0;
  resetDnsCheckCache();
});

describe("checkRecord", () => {
  it("matches a CNAME that resolves to the wanted target", async () => {
    queueValue(["abc.dkim.amazonses.com"]);
    const result = await checkRecord(cname);
    expect(result.verdict).toBe("match");
    expect(result.observed).toEqual(["abc.dkim.amazonses.com"]);
  });

  it("matches an MX regardless of trailing dot or case", async () => {
    queueValue([{ priority: 10, exchange: "Feedback-SMTP.us-west-2.amazonses.com." }]);
    const result = await checkRecord(mx);
    expect(result.verdict).toBe("match");
  });

  it("flags a present record with a different value", async () => {
    queueValue(["send.us-east-1.amazonses.com"]);
    const result = await checkRecord(cname);
    expect(result.verdict).toBe("different");
    expect(result.observed).toEqual(["send.us-east-1.amazonses.com"]);
  });

  it("matches a TXT record on exact string equality", async () => {
    queueValue([["v=spf1 include:amazonses.com ~all"]]);
    const result = await checkRecord(txt);
    expect(result.verdict).toBe("match");
  });

  it("joins multi-chunk TXT records before comparing", async () => {
    queueValue([["v=spf1 ", "include:amazonses.com ~all"]]);
    const result = await checkRecord(txt);
    expect(result.verdict).toBe("match");
  });

  it("reads NXDOMAIN as a definitive missing, not an error", async () => {
    queueError("ENOTFOUND");
    const result = await checkRecord(cname);
    expect(result.verdict).toBe("missing");
    expect(result.errorKind).toBe("not_found");
  });

  it("reads NODATA as missing", async () => {
    queueError("ENODATA");
    const result = await checkRecord(mx);
    expect(result.verdict).toBe("missing");
    expect(result.errorKind).toBe("not_found");
  });

  it("reads SERVFAIL as unresolved, never as missing", async () => {
    queueError("ESERVFAIL");
    const result = await checkRecord(cname);
    expect(result.verdict).toBe("unresolved");
    expect(result.errorKind).toBe("servfail");
  });

  it("reads a timeout as unresolved and cancels the outstanding query", async () => {
    vi.useFakeTimers();
    queue.push({ value: new Promise(() => {}) }); // never settles on its own
    const pending = checkRecord(cname);
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await pending;
    vi.useRealTimers();

    expect(result.verdict).toBe("unresolved");
    expect(result.errorKind).toBe("timeout");
    expect(cancelCalls).toHaveLength(1);
  });

  it("caches a lookup briefly so a second call doesn't hit the resolver again", async () => {
    queueValue(["abc.dkim.amazonses.com"]);
    await checkRecord(cname);
    const second = await checkRecord(cname);
    expect(second.verdict).toBe("match");
    expect(queue).toHaveLength(0);
  });
});

describe("checkRecords", () => {
  it("resolves every record in parallel and keeps them in order", async () => {
    queueValue(["abc.dkim.amazonses.com"]);
    queueValue([{ priority: 10, exchange: "feedback-smtp.us-west-2.amazonses.com" }]);
    const results = await checkRecords([cname, mx]);
    expect(results.map((r) => r.record.type)).toEqual(["CNAME", "MX"]);
    expect(results.every((r) => r.verdict === "match")).toBe(true);
  });
});
