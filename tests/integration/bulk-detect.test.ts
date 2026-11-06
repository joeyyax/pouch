import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { bulkFanoutRecipients, domains, messages } from "@/lib/db/schema";
import type { DomainLayout } from "@/lib/domains/layout";
import { acceptMessage } from "@/lib/messages/create";
import { BULK_FANOUT_THRESHOLD } from "@/lib/messages/bulk-detect";
import type { SendEmailRequest } from "@/lib/schemas/email";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

vi.hoisted(() => {
  process.env.BULK_FANOUT_THRESHOLD = "10";
});

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

/** One recipient per call, so each send is its own message row like a real caller looping. */
function sendOne(recipient: string, overrides: Partial<SendEmailRequest> = {}) {
  return acceptMessage(
    fixture.key,
    {
      from: "Ada <ada@example.com>",
      to: [recipient],
      subject: "Notice",
      html: "<p>The same notice, every time.</p>",
      ...overrides,
    },
    null,
  );
}

function notice(recipient: string): SendEmailRequest {
  return {
    from: "Ada <ada@example.com>",
    to: [recipient],
    subject: "Notice",
    html: "<p>The same notice, every time.</p>",
  };
}

/** Puts `count` seeded recipients on the key's ledger for the body, as if that many sends had gone out. */
async function fillLedger(target: Fixture, bodyHash: string | null, count: number): Promise<void> {
  const day = (await dbNow()).toISOString().slice(0, 10);
  await db.insert(bulkFanoutRecipients).values(
    Array.from({ length: count }, (_, i) => ({
      organizationId: target.organizationId,
      apiKeyId: target.key.id,
      bodyHash: bodyHash!,
      day,
      recipientHash: sha256(`seed${i}@example.net`),
    })),
  );
}

async function sendToMany(count: number, overrides: Partial<SendEmailRequest> = {}): Promise<void> {
  for (let i = 0; i < count; i++) {
    await sendOne(`person${i}@example.net`, overrides);
  }
}

describe("bulk fan-out detection", () => {
  it("holds an identical body past the threshold until List-Unsubscribe is set", async () => {
    await sendToMany(BULK_FANOUT_THRESHOLD);
    expect(await db.select().from(messages)).toHaveLength(BULK_FANOUT_THRESHOLD);

    await expect(sendOne(`person${BULK_FANOUT_THRESHOLD}@example.net`)).rejects.toMatchObject({
      code: "list_unsubscribe_required",
      field: "headers",
      detail: { threshold: BULK_FANOUT_THRESHOLD },
    });

    const { message } = await sendOne(`person${BULK_FANOUT_THRESHOLD}@example.net`, {
      headers: { "List-Unsubscribe": "<mailto:unsub@example.com>" },
    });
    expect(message.status).toBe("queued");
  });

  it("never trips on the same count of recipients when each body renders differently", async () => {
    for (let i = 0; i < BULK_FANOUT_THRESHOLD + 50; i++) {
      const { message } = await sendOne(`person${i}@example.net`, { html: `<p>Hi ${i}, here is your code.</p>` });
      expect(message.status).toBe("queued");
    }
  });

  it("hashes the rendered body, not the request: same html and text, different headers, is one hash", async () => {
    await sendOne("a@example.net", { tags: ["welcome"] });
    await sendOne("b@example.net", { subject: "A different subject entirely" });

    const rows = await db.select({ bodyHash: messages.bodyHash }).from(messages);
    const hashes = new Set(rows.map((row) => row.bodyHash));
    expect(hashes.size).toBe(1);
  });

  it("hashes the layout-wrapped bytes, not the caller's raw html", async () => {
    const layout: DomainLayout = { brandName: "Example", logoUrl: null, accent: "#1d46f5", footer: "Example, Inc." };
    await db.update(domains).set({ layout }).where(eq(domains.id, fixture.domainId));

    const plain = await sendOne("plain@example.net");
    const wrapped = await sendOne("wrapped@example.net", { layout: true });

    expect(plain.message.bodyHash).not.toBe(wrapped.message.bodyHash);
  });

  it("counts distinct recipients, not requests: the same address twice doesn't inflate the ledger", async () => {
    await sendToMany(BULK_FANOUT_THRESHOLD);
    // Replaying the very first recipient again shouldn't push a fresh count over the edge.
    await sendOne("person0@example.net", { tags: ["retry"] });

    const count = await db.select().from(bulkFanoutRecipients);
    // recipients are distinct: threshold, not threshold + 1.
    expect(new Set(count.map((row) => row.recipientHash)).size).toBe(BULK_FANOUT_THRESHOLD);
  });

  it("resets at the UTC day boundary", async () => {
    await sendToMany(BULK_FANOUT_THRESHOLD);
    await db.update(bulkFanoutRecipients).set({ day: "2020-01-01" });

    const { message } = await sendOne(`person${BULK_FANOUT_THRESHOLD}@example.net`);
    expect(message.status).toBe("queued");
  });

  it("does not require the header on a test-mode key even past the threshold", async () => {
    const testFixture = await seedFixture({ keyMode: "test" });
    const first = await acceptMessage(testFixture.key, notice("person0@example.net"), null);
    await fillLedger(testFixture, first.message.bodyHash, BULK_FANOUT_THRESHOLD);

    const { message } = await acceptMessage(testFixture.key, notice(`person${BULK_FANOUT_THRESHOLD}@example.net`), null);
    expect(message.status).toBe("queued");
  });

  it("refuses instead of clearing the hold on a provider that can't carry the header", async () => {
    const mailpace = await seedFixture({ providerAdapter: "mailpace" });
    const first = await acceptMessage(mailpace.key, notice("person0@example.net"), null);
    expect(first.message.status).toBe("queued");
    await fillLedger(mailpace, first.message.bodyHash, BULK_FANOUT_THRESHOLD - 1);

    const overThreshold = notice(`person${BULK_FANOUT_THRESHOLD}@example.net`);

    // Mailpace can never satisfy the ask, so the caller is never told to add a header —
    // straight to bulk_not_allowed instead of list_unsubscribe_required.
    await expect(acceptMessage(mailpace.key, overThreshold, null)).rejects.toMatchObject({
      code: "bulk_not_allowed",
    });

    // The bug this guards against: adding the header must never clear the hold when the
    // provider strips it in transit. A caller who adds it anyway is refused all the same —
    // here by the pre-existing "this provider carries no custom headers at all" guard, which
    // fires first and is just as final. Either way, the send does not go out unsubscribable.
    await expect(
      acceptMessage(mailpace.key, { ...overThreshold, headers: { "List-Unsubscribe": "<mailto:unsub@example.com>" } }, null),
    ).rejects.toMatchObject({ code: "provider_limit" });

    expect(await db.select().from(messages).where(eq(messages.apiKeyId, mailpace.key.id))).toHaveLength(1);
  });

  it("separates the ledger per key, so one caller's volume can't hold another's", async () => {
    const first = await sendOne("person0@example.net");
    await fillLedger(fixture, first.message.bodyHash, BULK_FANOUT_THRESHOLD);

    const other = await seedFixture();
    const { message } = await acceptMessage(other.key, notice("someone@example.net"), null);
    expect(message.status).toBe("queued");
  });
});
