import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, domains, messages, organizations } from "@/lib/db/schema";
import type { MessageStatus } from "@/lib/db/schema";
import { newMessageKey } from "@/lib/crypto";
import { LIST_WINDOW_DAYS } from "@/lib/dashboard/views/messages";
import {
  listMessages,
  listTags,
  readMessage,
  readMessageBody,
  queueSummary,
} from "@/lib/dashboard/messages";
import { recordEvent } from "@/lib/messages/events";
import { loadBody } from "@/lib/messages/body";
import { DEFAULT_STALL_LINES, type StallVerdict } from "@/lib/domains/guard";
import { stallDomain } from "@/lib/domains/stall";
import { providerActor, userActor, workerActor } from "@/lib/activity/record";
import { dbNow } from "@/lib/db/clock";
import { suspendOrganization } from "@/lib/suspension";
import { suppress } from "@/lib/messages/suppression";
import { newId } from "@/lib/ids";
import { newStorageKey, writeBody } from "@/lib/storage/bodies";
import { heldLink, heldSentence } from "@/app/(app)/messages/message-hold";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const DAY = 24 * 60 * 60 * 1000;

interface InsertOptions {
  organizationId: string;
  domainId: string;
  apiKeyId?: string | null;
  status?: MessageStatus;
  to?: string;
  cc?: string[];
  bcc?: string[];
  subject?: string;
  createdAt?: Date;
  from?: string;
  storageKey?: string | null;
  bodyKey?: string | null;
  bodyPurgedAt?: Date | null;
  tags?: string[];
  abandonedAt?: Date | null;
  sentAt?: Date | null;
}

async function insertMessage({ organizationId, domainId, ...rest }: InsertOptions): Promise<string> {
  return seedMessage({ organizationId, domainId }, { fromName: "Scope", ...rest });
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("listMessages", () => {
  it("returns only the caller's organization", async () => {
    const other = await seedFixture();
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, subject: "Ours" });
    await insertMessage({ organizationId: other.organizationId, domainId: other.domainId, subject: "Theirs" });

    const rows = await listMessages(fixture.organizationId);
    expect(rows.map((row) => row.subject)).toEqual(["Ours"]);
  });

  it("filters by domain name, status and recipient", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "First domain",
      status: "delivered",
      to: "one@example.com",
    });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: second.domainId,
      subject: "Second domain",
      status: "bounced",
      to: "two@example.com",
    });

    expect((await listMessages(fixture.organizationId, { domain: "second.example.com" })).map((r) => r.subject)).toEqual([
      "Second domain",
    ]);
    expect((await listMessages(fixture.organizationId, { statuses: ["bounced"] })).map((r) => r.subject)).toEqual([
      "Second domain",
    ]);
    expect((await listMessages(fixture.organizationId, { address: "one@example.com" })).map((r) => r.subject)).toEqual([
      "First domain",
    ]);
  });

  it("names each row's key and filters by it", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, subject: "Fixture key", apiKeyId: fixture.key.id });
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, subject: "Second key", apiKeyId: second.key.id });
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, subject: "No key", apiKeyId: null });

    const all = await listMessages(fixture.organizationId);
    const bySubject = new Map(all.map((row) => [row.subject, row]));
    expect(bySubject.get("Fixture key")).toMatchObject({ keyId: fixture.key.id, keyName: fixture.key.name });
    expect(bySubject.get("Second key")).toMatchObject({ keyId: second.key.id, keyName: second.key.name });
    expect(bySubject.get("No key")).toMatchObject({ keyId: null, keyName: null });

    expect((await listMessages(fixture.organizationId, { keyId: second.key.id })).map((r) => r.subject)).toEqual(["Second key"]);
  });

  it("matches an address filter on the normalized form", async () => {
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "Sam@example.com",
      subject: "Mixed case",
    });

    expect((await listMessages(fixture.organizationId, { address: "Sam@EXAMPLE.COM" })).map((r) => r.subject)).toEqual([
      "Mixed case",
    ]);
    expect(await listMessages(fixture.organizationId, { address: "sam@example.com" })).toEqual([]);
  });

  it("searches by id, subject and recipient", async () => {
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "Weekly digest",
      to: "ops@blueharbor.co",
    });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "Password reset",
      to: "someone@else.test",
    });

    expect((await listMessages(fixture.organizationId, { search: id })).map((r) => r.id)).toEqual([id]);
    expect((await listMessages(fixture.organizationId, { search: "digest" })).map((r) => r.id)).toEqual([id]);
    expect((await listMessages(fixture.organizationId, { search: "blueharbor" })).map((r) => r.id)).toEqual([id]);
  });

  it("leaves out anything older than the window", async () => {
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "Old",
      createdAt: new Date(Date.now() - (LIST_WINDOW_DAYS + 1) * DAY),
    });
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, subject: "New" });

    expect((await listMessages(fixture.organizationId)).map((r) => r.subject)).toEqual(["New"]);
  });

  it("counts a sent-only window from the send, not the creation", async () => {
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "Queued long, sent lately",
      status: "sent",
      createdAt: new Date(Date.now() - 2 * DAY),
      sentAt: new Date(Date.now() - 2 * 60 * 60_000),
    });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "Sent long ago",
      status: "sent",
      createdAt: new Date(Date.now() - 3 * DAY),
      sentAt: new Date(Date.now() - 2 * DAY),
    });
    const since = new Date(Date.now() - DAY);

    const sent = await listMessages(fixture.organizationId, { statuses: ["sent"], since });
    expect(sent.map((row) => row.subject)).toEqual(["Queued long, sent lately"]);
    expect(await listMessages(fixture.organizationId, { statuses: ["sent", "delivered"], since })).toEqual([]);
  });

  it("marks a suppressed recipient and a message stuck past the retry window", async () => {
    await suppress({ organizationId: fixture.organizationId, address: "gone@example.com", reason: "hard_bounce" });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "gone@example.com",
      subject: "Bounced one",
      status: "bounced",
    });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "waiting@example.com",
      subject: "Stuck one",
      status: "queued",
      createdAt: new Date(Date.now() - 30 * 60_000),
    });

    const rows = await listMessages(fixture.organizationId);
    const bySubject = new Map(rows.map((row) => [row.subject, row]));
    expect(bySubject.get("Bounced one")?.suppressed).toBe(true);
    expect(bySubject.get("Stuck one")?.suppressed).toBe(false);
    expect(bySubject.get("Stuck one")?.stuck).toBe(true);
    expect(bySubject.get("Bounced one")?.stuck).toBe(false);
  });

  it("matches a message carrying any of the given tags", async () => {
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "Receipt",
      tags: ["receipt", "billing"],
    });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "Newsletter",
      tags: ["newsletter"],
    });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      subject: "Untagged",
    });

    expect((await listMessages(fixture.organizationId, { tags: ["receipt"] })).map((r) => r.subject)).toEqual([
      "Receipt",
    ]);
    expect(
      (await listMessages(fixture.organizationId, { tags: ["receipt", "newsletter"] })).map((r) => r.subject).sort(),
    ).toEqual(["Newsletter", "Receipt"]);
  });
});

describe("listTags", () => {
  it("returns the distinct tags in the organization's list window", async () => {
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      tags: ["receipt", "billing"],
    });
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, tags: ["billing"] });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      tags: ["old"],
      createdAt: new Date(Date.now() - (LIST_WINDOW_DAYS + 1) * DAY),
    });
    const other = await seedFixture();
    await insertMessage({ organizationId: other.organizationId, domainId: other.domainId, tags: ["theirs"] });

    expect(await listTags(fixture.organizationId)).toEqual(["billing", "receipt"]);
  });

  it("scopes to a domain when one is given", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, tags: ["one"] });
    await insertMessage({ organizationId: fixture.organizationId, domainId: second.domainId, tags: ["two"] });

    expect(await listTags(fixture.organizationId, { domain: "second.example.com" })).toEqual(["two"]);
  });
});

describe("readMessage", () => {
  it("won't read another organization's message", async () => {
    const other = await seedFixture();
    const id = await insertMessage({ organizationId: other.organizationId, domainId: other.domainId });

    expect(await readMessage(fixture.organizationId, id)).toBeNull();
    expect(await readMessage(other.organizationId, id)).not.toBeNull();
  });

  it("orders the timeline newest first and counts every message to the address", async () => {
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      apiKeyId: fixture.key.id,
      to: "sam@example.com",
      status: "delivered",
    });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "sam@example.com",
      subject: "Another",
    });

    await recordEvent({
      organizationId: fixture.organizationId,
      messageId: id,
      status: "queued",
      occurredAt: new Date("2026-09-08T14:32:03Z"),
    });
    await recordEvent({
      organizationId: fixture.organizationId,
      messageId: id,
      status: "delivered",
      reason: "250 2.0.0 OK",
      occurredAt: new Date("2026-09-08T14:32:07Z"),
    });

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.events.map((event) => event.status)).toEqual(["delivered", "queued"]);
    expect(detail?.messageCount).toBe(2);
    expect(detail?.keyName).toBe("test");
    expect(detail?.keyId).toBe(fixture.key.id);
    expect(detail?.keyRevoked).toBe(false);
    expect(JSON.parse(detail?.api.plain.response ?? "{}").key_id).toBe(fixture.key.id);
  });

  it("says a revoked key is revoked, and has no key for a keyless send", async () => {
    const keyed = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, apiKeyId: fixture.key.id });
    const keyless = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, apiKeyId: null });
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, fixture.key.id));

    expect(await readMessage(fixture.organizationId, keyed)).toMatchObject({ keyId: fixture.key.id, keyName: "test", keyRevoked: true });
    expect(await readMessage(fixture.organizationId, keyless)).toMatchObject({ keyId: null, keyName: null, keyRevoked: false });
  });

  it("says a queued message is held by its domain's stall", async () => {
    const id = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "queued" });
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    const verdict: StallVerdict = {
      reason: "bounce_rate",
      detail: { metric: "bounce", count: 10, denominator: 100, rate: 0.1, previousRate: 0.1, threshold: DEFAULT_STALL_LINES.bounce.stall },
    };
    await stallDomain(domain!, verdict, await dbNow());

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.stall).toMatchObject({ kind: "domain", reason: "bounce_rate" });
    expect(heldSentence(detail!.stall!, detail!.domainName)).toBe(
      "Held while sending from example.com is paused for its bounce rate.",
    );
    expect(heldLink(detail!.stall!, fixture.domainId, detail!.domainName)).toEqual({
      href: `/domains/${fixture.domainId}/reputation`,
      label: "See reputation for example.com",
    });
  });

  it("says a queued message is held by its organization's reputation suspension", async () => {
    const id = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "queued" });
    await suspendOrganization(
      fixture.organizationId,
      {
        source: "reputation",
        reason: "Complaint rate is 1.00%, above our 0.10% action point.",
        detail: { reason: "complaint_trend", metric: "complaint", count: 1, denominator: 100, rate: 0.01, previousRate: 0.005, threshold: 0.001 },
      },
      workerActor("Reputation guard"),
    );

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.stall).toMatchObject({ kind: "organization", reason: "complaint_trend" });
    expect(heldSentence(detail!.stall!, detail!.domainName)).toBe(
      "Held while this organization is suspended on its rising complaint rate.",
    );
    expect(heldLink(detail!.stall!, fixture.domainId, detail!.domainName)).toEqual({ href: "/", label: "See the overview" });
  });

  it("says a queued message is held because the provider paused the organization", async () => {
    const id = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "queued" });
    await suspendOrganization(
      fixture.organizationId,
      { source: "provider", reason: "The email provider paused sending for this organization." },
      providerActor("pac_1", "Hosted"),
    );

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.stall).toMatchObject({ kind: "organization", reason: "provider_paused" });
    expect(heldSentence(detail!.stall!, detail!.domainName)).toBe(
      "Held while the email provider has paused sending for this organization.",
    );
    expect(heldLink(detail!.stall!, fixture.domainId, detail!.domainName)).toEqual({ href: "/", label: "See the overview" });
  });

  it("lists queued messages under the held filter for a provider suspension, not a manual one", async () => {
    const queued = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "queued" });
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId });

    await suspendOrganization(fixture.organizationId, { source: "manual", reason: "Phishing." }, userActor("u_1", "Olive"));
    expect(await listMessages(fixture.organizationId, { held: true })).toEqual([]);
    expect((await readMessage(fixture.organizationId, queued))?.stall).toBeNull();

    await db
      .update(organizations)
      .set({ suspendSource: "provider", suspendReason: "The email provider paused sending for this organization." })
      .where(eq(organizations.id, fixture.organizationId));
    expect((await listMessages(fixture.organizationId, { held: true })).map((row) => row.id)).toEqual([queued]);
  });

  it("has no hold for a queued message nothing is holding, or a delivered one", async () => {
    const queued = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "queued" });
    const delivered = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId });
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));

    expect((await readMessage(fixture.organizationId, queued))?.stall).toBeNull();
    await stallDomain(domain!, { reason: "bounce_count", detail: { metric: "bounce", count: 3, denominator: 5, rate: 0.6, previousRate: 0, threshold: DEFAULT_STALL_LINES.bounce.stall } }, await dbNow());
    expect((await readMessage(fixture.organizationId, delivered))?.stall).toBeNull();
  });

  it("builds a header block from the envelope and nothing it doesn't hold", async () => {
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "sam@example.com",
      subject: "Your invite",
    });

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.headers).toContain(`Message-ID: <${id}@example.com>`);
    expect(detail?.headers).toContain("To: sam@example.com");
    expect(detail?.headers).toContain("Subject: Your invite");
    expect(detail?.headers).not.toContain("DKIM-Signature");
  });

  it("carries the abandon sweep's mark, keeping status sent", async () => {
    const abandonedAt = new Date("2026-09-09T10:00:00Z");
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "sent",
      abandonedAt,
    });

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.status).toBe("sent");
    expect(detail?.abandonedAt?.toISOString()).toBe(abandonedAt.toISOString());
  });

  it("leaves an ordinary sent message unmarked", async () => {
    const id = await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "sent" });

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.abandonedAt).toBeNull();
  });
});

describe("loadBody", () => {
  async function rowFor(id: string) {
    const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1);
    if (!row) throw new Error("message not found");
    return row;
  }

  it("reads the body and sizes its attachments", async () => {
    const storageKey = newStorageKey();
    const createdAt = new Date();
    const { key: bodyKeyBuffer, encoded: bodyKey } = newMessageKey();
    await writeBody(bodyKeyBuffer, storageKey, {
      html: "<p>It works.</p>",
      text: "It works.",
      textGenerated: false,
      attachments: [{ filename: "invoice.pdf", content: "AAAA".repeat(64), contentType: "application/pdf" }],
    });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      storageKey,
      bodyKey,
      createdAt,
    });
    const [row] = await db.select().from(messages).where(eq(messages.storageKey, storageKey)).limit(1);

    const body = await loadBody(row!, 45);
    expect(body).toMatchObject({ state: "available", html: "<p>It works.</p>", text: "It works." });
    if (body.state !== "available") throw new Error("expected an available body");
    expect(body.attachments).toEqual([{ filename: "invoice.pdf", contentType: "application/pdf", bytes: 192 }]);
  });

  it.each([
    { when: "the sweep already shredded the key", extra: { bodyPurgedAt: new Date("2026-09-01T00:00:00Z") } },
    { when: "bodyKey is null even without bodyPurgedAt (legacy pre-encryption rows)", extra: {} },
  ])("says purged when $when", async ({ extra }) => {
    const purgedId = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      ...extra,
      storageKey: newStorageKey(),
      bodyKey: null,
    });
    expect((await loadBody(await rowFor(purgedId), 45)).state).toBe("purged");
  });

  it("says expired past the org's retention window, through readMessage's wiring", async () => {
    await db.update(organizations).set({ bodyRetentionDays: 7 }).where(eq(organizations.id, fixture.organizationId));
    const expiredId = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      createdAt: new Date(Date.now() - 8 * DAY),
      storageKey: newStorageKey(),
      bodyKey: newMessageKey().encoded,
    });
    const detail = await readMessageBody(fixture.organizationId, expiredId);
    expect(detail?.body.state).toBe("expired");
  });

  it("says unavailable when the body key is present but storage can't answer", async () => {
    const missingId = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      storageKey: "bodies/never-written",
      bodyKey: newMessageKey().encoded,
    });
    expect((await loadBody(await rowFor(missingId), 45)).state).toBe("unavailable");
  });
});

describe("queueSummary", () => {
  it("counts only this organization's queued messages", async () => {
    const other = await seedFixture();
    const oldest = new Date(Date.now() - 10 * 60_000);
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "queued",
      createdAt: oldest,
    });
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "queued" });
    await insertMessage({ organizationId: fixture.organizationId, domainId: fixture.domainId, status: "delivered" });
    await insertMessage({ organizationId: other.organizationId, domainId: other.domainId, status: "queued" });

    const summary = await queueSummary(fixture.organizationId);
    expect(summary.depth).toBe(2);
    expect(summary.oldestQueuedAt?.toISOString()).toBe(oldest.toISOString());
  });
});

describe("the framed body", () => {
  it("shows the html wrapped in the domain's layout when the send asked for one", async () => {
    const { domains } = await import("@/lib/db/schema");
    await db
      .update(domains)
      .set({ layout: { brandName: "Scope", logoUrl: null, accent: "#1d46f5", footer: "Scope · Portland, OR" } })
      .where(eq(domains.id, fixture.domainId));

    const id = newId("message");
    const createdAt = new Date();
    const storageKey = newStorageKey();
    const { key: bodyKeyBuffer, encoded: bodyKey } = newMessageKey();
    await writeBody(bodyKeyBuffer, storageKey, { html: "<p>Your invite is ready.</p>", text: null, textGenerated: false, attachments: [] });
    await db.insert(messages).values({
      id,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "delivered",
      fromAddress: "hi@example.com",
      recipients: ["sam@example.com"],
      subject: "Framed",
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
      storageKey,
      bodyKey,
      layout: true,
      createdAt,
    });

    const detail = await readMessageBody(fixture.organizationId, id);
    expect(detail?.framed).toBe(true);
    if (detail?.body.state !== "available") throw new Error("expected an available body");
    expect(detail.body.html).toContain("<p>Your invite is ready.</p>");
    expect(detail.body.html).toContain("Scope · Portland, OR");
  });

  it("leaves a send that didn't ask for a frame alone", async () => {
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      storageKey: null,
    });
    expect((await readMessageBody(fixture.organizationId, id))?.framed).toBe(false);
  });

  it("renders a per-send layout override on top of the domain's layout, not the domain's layout alone (#216)", async () => {
    const { domains } = await import("@/lib/db/schema");
    await db
      .update(domains)
      .set({ layout: { brandName: "Scope", logoUrl: null, accent: "#1d46f5", footer: "Scope · Portland, OR" } })
      .where(eq(domains.id, fixture.domainId));

    const id = newId("message");
    const storageKey = newStorageKey();
    const { key: bodyKeyBuffer, encoded: bodyKey } = newMessageKey();
    await writeBody(bodyKeyBuffer, storageKey, { html: "<p>Your invite is ready.</p>", text: null, textGenerated: false, attachments: [] });
    await db.insert(messages).values({
      id,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "delivered",
      fromAddress: "hi@example.com",
      recipients: ["sam@example.com"],
      subject: "Framed with an override",
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
      storageKey,
      bodyKey,
      layout: true,
      layoutOverrides: { footer: "Overridden footer for this send only" },
      createdAt: new Date(),
    });

    const detail = await readMessageBody(fixture.organizationId, id);
    if (detail?.body.state !== "available") throw new Error("expected an available body");
    // The override, not the domain's own footer.
    expect(detail.body.html).toContain("Overridden footer for this send only");
    expect(detail.body.html).not.toContain("Scope · Portland, OR");
  });
});

describe("a message with more than one recipient", () => {
  it("counts them all on the list rather than showing the first as the whole story", async () => {
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "one@example.com",
      cc: ["two@example.com"],
      bcc: ["three@example.com"],
      subject: "Sent to three",
    });

    const [row] = await listMessages(fixture.organizationId);
    expect(row?.to).toBe("one@example.com");
    expect(row?.recipientCount).toBe(3);
  });

  it("is suppressed when any recipient is, not only the first", async () => {
    await suppress({ organizationId: fixture.organizationId, address: "cc@example.com", reason: "complaint" });
    await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "fine@example.com",
      cc: ["cc@example.com"],
      subject: "One bad address",
    });

    expect((await listMessages(fixture.organizationId))[0]?.suppressed).toBe(true);
  });

  it("keeps to, cc and bcc apart on the detail", async () => {
    await suppress({ organizationId: fixture.organizationId, address: "blocked@example.com", reason: "hard_bounce" });
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "one@example.com",
      cc: ["blocked@example.com"],
      bcc: ["hidden@example.com"],
    });

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.recipients).toEqual([
      { address: "one@example.com", field: "to", suppressed: false, suppressedAt: null },
      { address: "blocked@example.com", field: "cc", suppressed: true, suppressedAt: expect.any(Date) },
      { address: "hidden@example.com", field: "bcc", suppressed: false, suppressedAt: null },
    ]);
    expect(detail?.messageCount).toBeNull();
  });

  it("still offers the count when there's exactly one recipient", async () => {
    const id = await insertMessage({
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      to: "solo@example.com",
    });
    const detail = await readMessage(fixture.organizationId, id);
    expect(detail?.recipients).toHaveLength(1);
    expect(detail?.messageCount).toBe(1);
  });
});