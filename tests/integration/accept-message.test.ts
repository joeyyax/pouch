import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents, messages } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { acceptMessage, type AcceptedMessage } from "@/lib/messages/create";
import { bodiesRoot, readBody } from "@/lib/storage/bodies";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getObject, storage, storageBucket } from "@/lib/storage";
import type { SendEmailRequest } from "@/lib/schemas/email";
import { addSuppression, countMessages, resetDatabase, seedFixture } from "./fixtures";

const request: SendEmailRequest = {
  from: "Ada <Ada@Example.com>",
  to: ["Person@EXAMPLE.net"],
  subject: "Hello",
  html: "<p>Hi</p>",
};

beforeEach(resetDatabase);

/**
 * Every object under this run's bodies prefix (`tests/storage-prefix.ts` isolates it from
 * every other checkout and process on the shared bucket).
 */
async function storedBodies(): Promise<Set<string>> {
  const keys = new Set<string>();
  let token: string | undefined;
  do {
    const page = await storage().send(
      new ListObjectsV2Command({ Bucket: storageBucket(), Prefix: `${bodiesRoot()}/`, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.add(object.Key);
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}

/** Objects written since `before`, split by whether a message row still points at them. */
async function bodiesAddedSince(before: Set<string>): Promise<{ keys: string[]; orphaned: string[] }> {
  const keys = [...(await storedBodies())].filter((key) => !before.has(key));
  const rows = await db.select({ storageKey: messages.storageKey }).from(messages);
  const referenced = new Set(rows.map((row) => `${row.storageKey}/body.json`));
  return { keys, orphaned: keys.filter((key) => !referenced.has(key)) };
}

describe("acceptMessage", () => {
  it("persists a queued message with normalized addresses", async () => {
    const fixture = await seedFixture();

    const { message } = await acceptMessage(fixture.key, request, null);

    expect(message.status).toBe("queued");
    expect(message.id).toMatch(/^msg_[0-9a-z]{24}$/);
    expect(message.fromAddress).toBe("Ada@example.com");
    expect(message.recipients).toEqual(["Person@example.net"]);
    expect(message.envelope.fromName).toBe("Ada");
  });

  it("writes one queued event alongside the message", async () => {
    const fixture = await seedFixture();

    const { message } = await acceptMessage(fixture.key, request, null);
    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, message.id));

    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("queued");
  });

  it("stores the body in object storage and keeps it out of the row", async () => {
    const fixture = await seedFixture();

    const { message } = await acceptMessage(
      fixture.key,
      { ...request, text: "Hi", attachments: [{ filename: "a.txt", content: "aGk=", content_type: "text/plain" }] },
      null,
    );

    expect(JSON.stringify(message)).not.toContain("<p>Hi</p>");
    expect(message.envelope.attachmentCount).toBe(1);

    const body = await readBody(Buffer.from(message.bodyKey ?? "", "base64"), message.storageKey ?? "");
    expect(body?.html).toBe("<p>Hi</p>");
    expect(body?.text).toBe("Hi");
    expect(body?.attachments[0]?.filename).toBe("a.txt");
  });

  it("encrypts the body so the raw object isn't a plain JSON StoredBody", async () => {
    const fixture = await seedFixture();

    const { message } = await acceptMessage(fixture.key, request, null);

    // Reading without the per-message key must not yield the StoredBody JSON.
    const stored = await getObject("private", `${message.storageKey}/body.json`);
    expect(stored).not.toContain('"html"');
    expect(stored).not.toContain("<p>Hi</p>");
  });

  it("gives every message a fresh body key and opaque storage key", async () => {
    const fixture = await seedFixture();

    const { message: first } = await acceptMessage(fixture.key, request, null);
    const { message: second } = await acceptMessage(fixture.key, request, null);

    expect(first.bodyKey).not.toBeNull();
    expect(second.bodyKey).not.toBeNull();
    expect(first.bodyKey).not.toBe(second.bodyKey);
    // The key should decode to 32 bytes.
    expect(Buffer.from(first.bodyKey ?? "", "base64").length).toBe(32);
    // The storage key is opaque: <root>/<random> with nothing naming the org or message id.
    expect(first.storageKey).toMatch(new RegExp(`^${bodiesRoot()}/[A-Za-z0-9_-]+$`));
    expect(second.storageKey).not.toBe(first.storageKey);
    expect(first.storageKey).not.toContain(fixture.organizationId);
    expect(first.storageKey).not.toContain(first.id);
  });

  it("marks a send from a test-mode key", async () => {
    const fixture = await seedFixture({ keyMode: "test" });

    const { message } = await acceptMessage(fixture.key, request, null);

    expect(message.testMode).toBe(true);
  });
});

describe("deriving text from html", () => {
  it("derives a plain-text part when the caller sends html alone", async () => {
    const fixture = await seedFixture();

    const { message } = await acceptMessage(
      fixture.key,
      { ...request, html: '<h1>Hi</h1><p>Visit <a href="https://example.com">our site</a>.</p>' },
      null,
    );

    const body = await readBody(Buffer.from(message.bodyKey ?? "", "base64"), message.storageKey ?? "");
    expect(body?.text).toBe("Hi\n\nVisit our site https://example.com.");
    expect(body?.text).not.toMatch(/<[^>]+>/);
    expect(body?.textGenerated).toBe(true);
  });

  it("never overwrites an explicit text part", async () => {
    const fixture = await seedFixture();

    const { message } = await acceptMessage(
      fixture.key,
      { ...request, html: "<p>Rich version</p>", text: "Plain version, on purpose." },
      null,
    );

    const body = await readBody(Buffer.from(message.bodyKey ?? "", "base64"), message.storageKey ?? "");
    expect(body?.text).toBe("Plain version, on purpose.");
    expect(body?.textGenerated).toBe(false);
  });

  it("treats an explicit empty string as html-only, not absence", async () => {
    const fixture = await seedFixture();

    const { message } = await acceptMessage(fixture.key, { ...request, html: "<p>Hi</p>", text: "" }, null);

    const body = await readBody(Buffer.from(message.bodyKey ?? "", "base64"), message.storageKey ?? "");
    expect(body?.text).toBe("");
    expect(body?.textGenerated).toBe(false);
  });

  it("leaves text alone for a text-only send, with no html to derive from", async () => {
    const fixture = await seedFixture();
    const { html: _html, ...withoutHtml } = request;

    const { message } = await acceptMessage(fixture.key, { ...withoutHtml, text: "Plain only" }, null);

    const body = await readBody(Buffer.from(message.bodyKey ?? "", "base64"), message.storageKey ?? "");
    expect(body?.html).toBeNull();
    expect(body?.text).toBe("Plain only");
    expect(body?.textGenerated).toBe(false);
  });
});

describe("suppression", () => {
  it("rejects a send to a suppressed recipient and persists nothing", async () => {
    const fixture = await seedFixture();
    await addSuppression(fixture.organizationId, "Person@example.net");

    await expect(acceptMessage(fixture.key, request, null)).rejects.toMatchObject({
      code: "recipient_suppressed",
      field: "to",
    });
    expect(await countMessages()).toBe(0);
  });

  it("matches across domain-part casing on both sides", async () => {
    const fixture = await seedFixture();
    await addSuppression(fixture.organizationId, "Person@EXAMPLE.NET");

    await expect(
      acceptMessage(fixture.key, { ...request, to: ["Person@example.net"] }, null),
    ).rejects.toMatchObject({ code: "recipient_suppressed" });
  });

  it("treats a different local-part case as a different address", async () => {
    const fixture = await seedFixture();
    await addSuppression(fixture.organizationId, "person@example.net");

    const { message } = await acceptMessage(fixture.key, { ...request, to: ["PERSON@example.net"] }, null);
    expect(message.status).toBe("queued");
  });

  it("names the reason and the date in the message", async () => {
    const fixture = await seedFixture();
    await addSuppression(fixture.organizationId, "Person@example.net");

    const error = await acceptMessage(fixture.key, request, null).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toMatch(/^Recipient is suppressed: hard bounce on \d{4}-\d{2}-\d{2}\.$/);
  });

  it.each(["bcc", "cc"] as const)("catches a suppressed address in %s, not only in to, and names it as the field", async (field) => {
    const fixture = await seedFixture();
    await addSuppression(fixture.organizationId, "hidden@example.net");

    await expect(
      acceptMessage(fixture.key, { ...request, [field]: ["hidden@example.net"] }, null),
    ).rejects.toMatchObject({ code: "recipient_suppressed", field });
  });

  it("does not apply another organization's suppressions", async () => {
    const fixture = await seedFixture();
    const other = await seedFixture();
    await addSuppression(other.organizationId, "Person@example.net");

    const { message } = await acceptMessage(fixture.key, request, null);
    expect(message.status).toBe("queued");
  });
});

describe("domain and key scope", () => {
  it("refuses a domain that is not verified", async () => {
    const fixture = await seedFixture({ domainStatus: "pending" });

    await expect(acceptMessage(fixture.key, request, null)).rejects.toMatchObject({
      code: "domain_not_verified",
      field: "from",
    });
  });

  it("refuses a domain the organization does not have, distinctly from one that's pending", async () => {
    const fixture = await seedFixture();

    await expect(
      acceptMessage(fixture.key, { ...request, from: "ada@other.com" }, null),
    ).rejects.toMatchObject({
      code: "domain_not_verified",
      message: expect.stringContaining("hasn't been added"),
      detail: { exists: false },
    });
  });

  it("refuses a key scoped to a different domain", async () => {
    const fixture = await seedFixture();
    const scoped = { ...fixture.key, domainIds: ["dom_somethingelse00000000"] };

    await expect(acceptMessage(scoped, request, null)).rejects.toMatchObject({
      code: "key_not_scoped",
      field: "from",
    });
  });

  it("allows a key with an empty scope to send from any domain in the organization", async () => {
    const fixture = await seedFixture({ scopeToDomain: false });

    const { message } = await acceptMessage(fixture.key, request, null);
    expect(message.domainId).toBe(fixture.domainId);
  });
});

describe("validation", () => {
  it("rejects a reserved header", async () => {
    const fixture = await seedFixture();

    await expect(
      acceptMessage(fixture.key, { ...request, headers: { "Message-ID": "<forged@example.com>" } }, null),
    ).rejects.toMatchObject({ code: "reserved_header", field: "headers" });
  });

  it("allows a custom header when the provider carries them", async () => {
    const fixture = await seedFixture();

    const { message } = await acceptMessage(fixture.key, { ...request, headers: { "X-Trace": "abc" } }, null);
    expect(message.envelope.headers).toEqual({ "X-Trace": "abc" });
  });

  it("refuses a custom header the domain's provider would drop, naming the headers", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });

    await expect(
      acceptMessage(fixture.key, { ...request, headers: { "X-Trace": "abc", "X-Batch": "7" } }, null),
    ).rejects.toMatchObject({
      code: "provider_limit",
      field: "headers",
      detail: { custom_headers: false, headers: ["X-Trace", "X-Batch"] },
    });
  });

  it("rejects more recipients than the provider accepts, counted across to, cc and bcc", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const to = Array.from({ length: 30 }, (_, i) => `person${i}@example.com`);
    const cc = Array.from({ length: 30 }, (_, i) => `copy${i}@example.com`);

    const error = await acceptMessage(fixture.key, { ...request, to, cc }, null).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: "provider_limit", field: "to" });
    expect((error as ApiError).detail).toMatchObject({ max_recipients: 50, recipients: 60 });
  });

  it("accepts exactly the provider's recipient ceiling", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const to = Array.from({ length: 30 }, (_, i) => `person${i}@example.com`);
    const cc = Array.from({ length: 20 }, (_, i) => `copy${i}@example.com`);

    const { message } = await acceptMessage(fixture.key, { ...request, to, cc }, null);
    expect(message.status).toBe("queued");
  });

  it("rejects an unparseable recipient", async () => {
    const fixture = await seedFixture();

    await expect(
      acceptMessage(fixture.key, { ...request, to: ["not-an-address"] }, null),
    ).rejects.toMatchObject({ code: "validation_failed", field: "to" });
  });

  it("rejects attachments past the size limit, measured decoded", async () => {
    const fixture = await seedFixture();
    const oversize = "a".repeat(28 * 1024 * 1024);

    const error = await acceptMessage(
      fixture.key,
      { ...request, attachments: [{ filename: "big.txt", content: oversize, content_type: "text/plain" }] },
      null,
    ).catch((err: unknown) => err);

    expect(error).toMatchObject({ code: "attachment_too_large" });
    expect((error as ApiError).detail).toMatchObject({ limit_bytes: 20 * 1024 * 1024 });
    expect(((error as ApiError).detail as { size_bytes: number }).size_bytes).toBeGreaterThan(20 * 1024 * 1024);
  });

  it("accepts a base64 payload whose character count exceeds the limit but decodes under it", async () => {
    const fixture = await seedFixture();
    const content = "a".repeat(24 * 1024 * 1024);

    const { message } = await acceptMessage(
      fixture.key,
      { ...request, attachments: [{ filename: "big.txt", content, content_type: "text/plain" }] },
      null,
    );

    expect(message.envelope.attachmentCount).toBe(1);
  });

  it("accepts an address repeated across to and cc, stored once in recipients", async () => {
    const fixture = await seedFixture({ providerAdapter: "mailpace" });
    const shared = Array.from({ length: 25 }, (_, i) => `person${i}@example.com`);

    const { message } = await acceptMessage(fixture.key, { ...request, to: shared, cc: [...shared] }, null);

    expect(message.status).toBe("queued");
    expect(message.recipients).toHaveLength(25);
  });
});

describe("idempotency", () => {
  it("returns the original message for a repeat with the same body", async () => {
    const fixture = await seedFixture();

    const first = await acceptMessage(fixture.key, request, "order-42");
    const second = await acceptMessage(fixture.key, request, "order-42");

    expect(second.message.id).toBe(first.message.id);
    expect(second.replayed).toBe(true);
    expect(await countMessages()).toBe(1);
  });

  it("ignores field order when comparing the repeat", async () => {
    const fixture = await seedFixture();

    const first = await acceptMessage(fixture.key, request, "order-43");
    const reordered = { subject: "Hello", html: "<p>Hi</p>", to: request.to, from: request.from };
    const second = await acceptMessage(fixture.key, reordered as SendEmailRequest, "order-43");

    expect(second.message.id).toBe(first.message.id);
  });

  it("conflicts when the same key carries a different body", async () => {
    const fixture = await seedFixture();
    const first = await acceptMessage(fixture.key, request, "order-44");

    await expect(
      acceptMessage(fixture.key, { ...request, subject: "Different" }, "order-44"),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
      detail: { message_id: first.message.id, window_expired: false },
    });
    expect(await countMessages()).toBe(1);
  });

  it("scopes the key to the organization", async () => {
    const fixture = await seedFixture();
    const other = await seedFixture();

    await acceptMessage(fixture.key, request, "shared");
    const { message } = await acceptMessage(other.key, request, "shared");

    expect(await countMessages()).toBe(2);
    expect(message.organizationId).toBe(other.organizationId);
  });

  it("leaves no stored body behind when a concurrent request loses the key", async () => {
    const fixture = await seedFixture();
    const before = await storedBodies();

    const results = await Promise.all([
      acceptMessage(fixture.key, request, "race-3"),
      acceptMessage(fixture.key, request, "race-3"),
    ]);

    expect(results[0].message.id).toBe(results[1].message.id);
    expect(await countMessages()).toBe(1);
    const added = await bodiesAddedSince(before);
    expect(added.orphaned).toEqual([]);
    expect(added.keys).toContain(`${results[0].message.storageKey}/body.json`);
  });

  it("leaves no stored body behind when a concurrent request conflicts", async () => {
    const fixture = await seedFixture();
    const before = await storedBodies();

    const settled = await Promise.allSettled([
      acceptMessage(fixture.key, request, "race-4"),
      acceptMessage(fixture.key, { ...request, subject: "Different" }, "race-4"),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((result) => result.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ code: "idempotency_conflict" });
    expect(await countMessages()).toBe(1);

    const kept = settled.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<AcceptedMessage>;
    const added = await bodiesAddedSince(before);
    expect(added.orphaned).toEqual([]);
    expect(added.keys).toContain(`${kept.value.message.storageKey}/body.json`);
  });

  it("refuses to replay a message the key isn't scoped to send", async () => {
    const fixture = await seedFixture();
    await acceptMessage(fixture.key, request, "scoped-1");
    const otherScope = { ...fixture.key, domainIds: ["dom_somethingelse00000000"] };

    await expect(acceptMessage(otherScope, request, "scoped-1")).rejects.toMatchObject({
      code: "key_not_scoped",
    });
  });

  it("conflicts rather than colliding when a key is reused past the replay window", async () => {
    const fixture = await seedFixture();
    const first = await acceptMessage(fixture.key, request, "aged-1");
    await db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(messages.id, first.message.id));

    await expect(acceptMessage(fixture.key, request, "aged-1")).rejects.toMatchObject({
      code: "idempotency_conflict",
      detail: { message_id: first.message.id, window_expired: true },
    });
  });

  it("separates an aged-out replay from a body mismatch in the message", async () => {
    const fixture = await seedFixture();
    const first = await acceptMessage(fixture.key, request, "aged-2");
    await db
      .update(messages)
      .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(messages.id, first.message.id));

    const aged = await acceptMessage(fixture.key, request, "aged-2").catch((err: unknown) => err as ApiError);
    const changed = await acceptMessage(fixture.key, { ...request, subject: "Different" }, "aged-2").catch(
      (err: unknown) => err as ApiError,
    );

    expect(aged.message).toContain("replay window");
    expect(changed.message).toContain("different request body");
  });

  it("accepts two sends with no idempotency key as separate messages", async () => {
    const fixture = await seedFixture();

    await acceptMessage(fixture.key, request, null);
    await acceptMessage(fixture.key, request, null);

    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.organizationId, fixture.organizationId)));
    expect(rows).toHaveLength(2);
  });
});