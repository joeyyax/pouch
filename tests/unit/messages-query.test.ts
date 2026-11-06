import { describe, expect, it } from "vitest";
import { readMessagesQuery } from "@/lib/messages/query";
import { messagesHref } from "@/lib/messages/link";

describe("readMessagesQuery days and retried", () => {
  it("reads a day range into a since date and an active filter", () => {
    const before = Date.now();
    const query = readMessagesQuery({ days: "3" });
    expect(query.days).toBe(3);
    expect(query.narrowed).toBe(true);
    expect(query.filters.since?.getTime()).toBeGreaterThanOrEqual(before - 3 * 86_400_000);
    expect(query.filters.since?.getTime()).toBeLessThanOrEqual(Date.now() - 3 * 86_400_000 + 1000);
  });

  it("falls back to the default window for a bad range", () => {
    for (const days of ["0", "-2", "abc", "9999", ""]) {
      const query = readMessagesQuery({ days });
      expect(query.days).toBe(7);
      expect(query.filters.since).toBeUndefined();
      expect(query.narrowed).toBe(false);
    }
  });

  it("reads retried=1 only", () => {
    expect(readMessagesQuery({ retried: "1" }).filters.retried).toBe(true);
    expect(readMessagesQuery({ retried: "0" }).filters.retried).toBeUndefined();
  });

  it("reads a key id into the filter and counts it as narrowing", () => {
    const query = readMessagesQuery({ key: "key_abc" });
    expect(query.keyId).toBe("key_abc");
    expect(query.filters.keyId).toBe("key_abc");
    expect(query.narrowed).toBe(true);
    expect(readMessagesQuery({}).filters.keyId).toBeUndefined();
  });

  it("round-trips a key link", () => {
    const params = Object.fromEntries(new URL(messagesHref({ key: "key_abc", days: 30 }), "http://x").searchParams);
    const query = readMessagesQuery(params);
    expect(query.keyId).toBe("key_abc");
    expect(query.days).toBe(30);
  });

  it("round-trips what messagesHref builds", () => {
    const href = messagesHref({ domain: "my site.com", statuses: ["bounced"], days: 7 });
    const params = Object.fromEntries(new URL(href, "http://x").searchParams);
    const query = readMessagesQuery(params);
    expect(query.scope).toBe("my site.com");
    expect(query.statuses).toEqual(["bounced"]);
    expect(query.days).toBe(7);
  });
});
