import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { messageEvents, messages } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { GET as list } from "@/app/api/v1/emails/route";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { resetMockSends } from "@/lib/providers/adapters/mock";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

interface SerializedMessage {
  id: string;
  subject: string;
  status: MessageStatus;
  tags: string[];
  key_id: string | null;
  created_at: string;
}

function request(secret: string, path: string): Request {
  return new Request(`http://localhost/v1/emails${path}`, {
    headers: { authorization: `Bearer ${secret}` },
  });
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  resetMockSends();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => vi.unstubAllGlobals());

/** Inserts a message row directly, so tests can control status, tags and createdAt precisely. */
async function addMessage(options: {
  domainId?: string;
  apiKeyId?: string | null;
  status?: MessageStatus;
  tags?: string[];
  subject?: string;
  createdAt?: Date;
}): Promise<string> {
  return seedMessage(
    { organizationId: fixture.organizationId, domainId: options.domainId ?? fixture.domainId },
    { status: options.status ?? "queued", subject: options.subject ?? "Hello", to: "sam@example.com", tags: options.tags, createdAt: options.createdAt, apiKeyId: options.apiKeyId ?? null },
  );
}

describe("GET /v1/emails", () => {
  it("lists the organization's messages, newest first", async () => {
    await addMessage({ subject: "First", createdAt: new Date(Date.now() - 1000) });
    await addMessage({ subject: "Second" });

    const body = (await (await list(request(fixture.secret, ""))).json()) as { data: SerializedMessage[]; next_cursor: string | null };

    expect(body.data.map((message) => message.subject)).toEqual(["Second", "First"]);
    expect(body.next_cursor).toBeNull();
  });

  it("pages with a cursor across a real boundary", async () => {
    await addMessage({ subject: "One", createdAt: new Date(Date.now() - 2000) });
    await addMessage({ subject: "Two", createdAt: new Date(Date.now() - 1000) });
    await addMessage({ subject: "Three" });

    const first = (await (await list(request(fixture.secret, "?limit=2"))).json()) as {
      data: SerializedMessage[];
      next_cursor: string | null;
    };
    expect(first.data.map((m) => m.subject)).toEqual(["Three", "Two"]);
    expect(first.next_cursor).not.toBeNull();

    const second = (await (await list(request(fixture.secret, `?limit=2&cursor=${first.next_cursor}`))).json()) as {
      data: SerializedMessage[];
      next_cursor: string | null;
    };
    expect(second.data.map((m) => m.subject)).toEqual(["One"]);
    expect(second.next_cursor).toBeNull();
  });

  it("ignores a cursor that names another organization's message", async () => {
    const other = await seedFixture();
    const otherMessageId = newId("message");
    await db.insert(messages).values({
      id: otherMessageId,
      organizationId: other.organizationId,
      domainId: other.domainId,
      status: "queued",
      fromAddress: "hi@example.com",
      recipients: ["sam@example.com"],
      subject: "Not mine",
      envelope: {
        from: "hi@example.com",
        fromName: null,
        to: ["sam@example.com"],
        cc: [],
        bcc: [],
        replyTo: [],
        headers: {},
        attachmentCount: 0,
      },
      tags: [],
    });
    await addMessage({ subject: "Mine" });

    const body = (await (await list(request(fixture.secret, `?cursor=${otherMessageId}`))).json()) as {
      data: SerializedMessage[];
    };

    expect(body.data.map((m) => m.subject)).toEqual(["Mine"]);
  });

  it("filters by status", async () => {
    await addMessage({ status: "delivered", subject: "Delivered" });
    await addMessage({ status: "bounced", subject: "Bounced" });

    const body = (await (await list(request(fixture.secret, "?status=bounced"))).json()) as { data: SerializedMessage[] };

    expect(body.data.map((m) => m.subject)).toEqual(["Bounced"]);
  });

  it("filters by domain", async () => {
    const second = await addDomainKey(fixture);
    await addMessage({ subject: "First domain" });
    await addMessage({ domainId: second.domainId, subject: "Second domain" });

    const body = (await (await list(request(fixture.secret, `?domain=${second.domainId}`))).json()) as { data: SerializedMessage[] };

    expect(body.data.map((m) => m.subject)).toEqual(["Second domain"]);
  });

  it("names the key that sent each message, and null for one sent without a key", async () => {
    const keyed = await addMessage({ subject: "Keyed", apiKeyId: fixture.key.id });
    const keyless = await addMessage({ subject: "Keyless", apiKeyId: null });

    const body = (await (await list(request(fixture.secret, ""))).json()) as { data: (SerializedMessage & { id: string })[] };

    const byId = new Map(body.data.map((message) => [message.id, message.key_id]));
    expect(byId.get(keyed)).toBe(fixture.key.id);
    expect(byId.get(keyless)).toBeNull();
  });

  it("filters by key", async () => {
    const second = await addDomainKey(fixture);
    await addMessage({ subject: "Fixture key", apiKeyId: fixture.key.id });
    await addMessage({ subject: "Second key", apiKeyId: second.key.id });
    await addMessage({ subject: "No key", apiKeyId: null });

    const body = (await (await list(request(fixture.secret, `?key=${second.key.id}`))).json()) as { data: SerializedMessage[] };

    expect(body.data.map((m) => m.subject)).toEqual(["Second key"]);
    expect(body.data.every((m) => m.key_id === second.key.id)).toBe(true);
  });

  it("keeps a domain-scoped key inside its domains when it filters by another key", async () => {
    const second = await addDomainKey(fixture);
    await addMessage({ subject: "Fixture key, first domain", apiKeyId: fixture.key.id });
    await addMessage({ domainId: second.domainId, subject: "Fixture key, second domain", apiKeyId: fixture.key.id });

    const body = (await (await list(request(second.secret, `?key=${fixture.key.id}`))).json()) as { data: SerializedMessage[] };

    expect(body.data.map((m) => m.subject)).toEqual(["Fixture key, second domain"]);
  });

  it("filters by tag", async () => {
    await addMessage({ tags: ["welcome"], subject: "Welcome" });
    await addMessage({ tags: ["receipt"], subject: "Receipt" });

    const body = (await (await list(request(fixture.secret, "?tag=receipt"))).json()) as { data: SerializedMessage[] };

    expect(body.data.map((m) => m.subject)).toEqual(["Receipt"]);
  });

  it("filters by recipient on its normalized form, across to, cc and bcc", async () => {
    const direct = await seedMessage(fixture, { subject: "To", to: "Ada@example.net" });
    const copied = await seedMessage(fixture, { subject: "Bcc", to: "sam@example.com", bcc: ["Ada@example.net"] });
    await seedMessage(fixture, { subject: "Other", to: "ada@example.org" });

    const body = (await (await list(request(fixture.secret, "?to=Ada%40EXAMPLE.net"))).json()) as { data: { id: string }[] };

    expect(body.data.map((message) => message.id).sort()).toEqual([direct, copied].sort());
  });

  it("filters by the exact reason on a bounce or complaint", async () => {
    const event = async (messageId: string, status: MessageStatus, reason: string) =>
      db.insert(messageEvents).values({ id: newId("event"), organizationId: fixture.organizationId, messageId, status, reason });
    const unknown = await addMessage({ status: "bounced", subject: "Unknown" });
    await event(unknown, "bounced", "550 5.1.1 user unknown");
    const complained = await addMessage({ status: "complained", subject: "Complained" });
    await event(complained, "complained", "550 5.1.1 user unknown");
    const full = await addMessage({ status: "bounced", subject: "Full" });
    await event(full, "bounced", "552 mailbox full");
    const deferred = await addMessage({ status: "delivered", subject: "Deferred first" });
    await event(deferred, "deferred", "550 5.1.1 user unknown");

    const body = (await (await list(request(fixture.secret, `?reason=${encodeURIComponent("550 5.1.1 user unknown")}`))).json()) as {
      data: SerializedMessage[];
    };

    expect(body.data.map((m) => m.subject).sort()).toEqual(["Complained", "Unknown"]);
    const prefix = (await (await list(request(fixture.secret, "?reason=550"))).json()) as { data: SerializedMessage[] };
    expect(prefix.data).toEqual([]);
  });

  it("filters by since and until on created_at", async () => {
    const now = Date.now();
    await addMessage({ subject: "Old", createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000) });
    await addMessage({ subject: "Recent", createdAt: new Date(now - 1000) });

    const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const body = (await (await list(request(fixture.secret, `?since=${since}`))).json()) as { data: SerializedMessage[] };

    expect(body.data.map((m) => m.subject)).toEqual(["Recent"]);
  });

  it("shows a key scoped to one domain only that domain's messages", async () => {
    const second = await addDomainKey(fixture);
    await addMessage({ subject: "First domain" });
    await addMessage({ domainId: second.domainId, subject: "Second domain" });

    const body = (await (await list(request(second.secret, ""))).json()) as { data: SerializedMessage[] };

    expect(body.data.map((m) => m.subject)).toEqual(["Second domain"]);
  });

  it("rejects a status that isn't a lifecycle value", async () => {
    const response = await list(request(fixture.secret, "?status=deleted"));
    const body = (await response.json()) as { error: { code: string; field?: string } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.field).toBe("status");
  });
});
