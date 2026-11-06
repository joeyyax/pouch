import { readFileSync } from "node:fs";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents } from "@/lib/db/schema";
import { readMessageBody, readMessageWithBody } from "@/lib/dashboard/messages";
import { loadExportBody } from "@/lib/exports/eml";
import { loadBody } from "@/lib/messages/body";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { mockSends, resetMockSends } from "@/lib/providers/adapters/mock";
import { sendSystemMail } from "@/lib/mail/system";
import { SystemMail } from "@/lib/mail/template";
import { readBody } from "@/lib/storage/bodies";
import { deliver } from "@/worker/send";
import { RetentionLoop } from "@/worker/retention";
import { messageRow, resetDatabase, seedFixture, seedSystemOrganization, systemMailMessages, type Fixture } from "./fixtures";

const LINK = "https://pouch.example/reset-password?token=SECRETTOKEN123";

function mail(heading: string) {
  return createElement(SystemMail, { heading, paragraphs: [`Open ${LINK} to continue.`], reason: "You asked for this." });
}

async function sendCredential(): Promise<void> {
  await sendSystemMail({
    to: "admin@example.net",
    subject: "Reset your password",
    email: mail("Reset your password"),
    tags: ["password-reset"],
    idempotencyKey: "password-reset:one",
    withhold: "a password reset link",
  });
}

async function sendPlain(): Promise<void> {
  await sendSystemMail({
    to: "admin@example.net",
    subject: "Weekly digest",
    email: mail("Weekly digest"),
    tags: ["digest"],
    idempotencyKey: "digest:one",
  });
}

async function deliverAll(): Promise<void> {
  for (const provider of await dueProviders()) {
    for (const item of await claimMessages({ workerId: "worker-test", providerId: provider.id, limit: 10 })) await deliver(item);
  }
}

const sweep = () => new RetentionLoop({ intervalMs: 60_000, batchSize: 100 }).tick();

async function byTag(tag: string) {
  const row = (await systemMailMessages()).find((message) => message.tags.includes(tag));
  return row!;
}

let systemOrganizationId: string;

beforeEach(async () => {
  await resetDatabase();
  resetMockSends();
  systemOrganizationId = (await seedSystemOrganization()).organizationId;
});

describe("a message that carries a credential", () => {
  it("still goes out with the real link", async () => {
    await sendCredential();
    await deliverAll();

    const [sent] = mockSends();
    expect(sent!.message.text ?? sent!.message.html).toContain("SECRETTOKEN123");
  });

  it("is not readable through the dashboard loader, the API read or the export, before or after the sweep", async () => {
    await sendCredential();
    const message = await byTag("password-reset");
    expect(message.bodyWithheld).toBe("a password reset link");

    const check = async () => {
      const row = await messageRow(message.id);
      // The organization holding the domain doesn't hold the message.
      expect(await readMessageBody(systemOrganizationId, message.id)).toBeNull();
      expect(await readMessageWithBody(systemOrganizationId, message.id)).toBeNull();
      expect((await loadExportBody(row, 45)).status).toBe("withheld");
    };

    await check();
    await sweep();
    await check();
  });

  it("keeps delivery events, and its body key is shredded only once it has left the queue", async () => {
    await sendCredential();
    const queued = await byTag("password-reset");

    await sweep();
    expect((await messageRow(queued.id)).bodyKey).not.toBeNull();

    await deliverAll();
    await sweep();

    const after = await messageRow(queued.id);
    expect(after.status).toBe("sent");
    expect(after.bodyKey).toBeNull();
    expect(after.bodyPurgedAt).not.toBeNull();
    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, queued.id));
    expect(events.map((event) => event.status ?? event.kind)).toEqual(expect.arrayContaining(["queued", "sent", "body_shredded"]));
  });
});

describe("a normal system message", () => {
  it("is still readable, and the sweep leaves its key", async () => {
    await sendPlain();
    await deliverAll();
    await sweep();

    const message = await byTag("digest");
    expect(message.bodyWithheld).toBeNull();
    expect(message.bodyKey).not.toBeNull();
    const body = await loadBody(message, 45);
    expect(body.state).toBe("available");
    expect(body.state === "available" && body.text).toContain("SECRETTOKEN123");
  });
});

describe("every sender of a credential withholds the body", () => {
  it.each([
    ["lib/auth/password-reset.ts", "password-reset"],
    ["lib/auth/magic-link.ts", "magic-link"],
    ["lib/invitations/mail.ts", "invitation"],
    ["lib/addresses/forward-targets.ts", "forward-confirmation"],
  ])("%s", (file, tag) => {
    const source = readFileSync(file, "utf8");
    expect(source).toMatch(new RegExp(`tags: \\["${tag}"\\],\\s+withhold: "`));
  });
});

describe("the migration that withholds mail sent before the column existed", () => {
  const statements = readFileSync("drizzle/0077_stormy_ser_duncan.sql", "utf8")
    .split("--> statement-breakpoint")
    .slice(1);

  it("withholds and shreds an already-sent reset, and leaves a tenant's message with the same tag alone", async () => {
    // Sent as it was before: no withhold.
    await sendSystemMail({
      to: "admin@example.net",
      subject: "Reset your password",
      email: mail("Reset your password"),
      tags: ["password-reset"],
      idempotencyKey: "password-reset:legacy",
    });
    await deliverAll();

    const tenant: Fixture = await seedFixture();
    const { message: tenantMessage } = await acceptMessage(
      tenant.key,
      { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Reset", html: "<p>Hi</p>", tags: ["password-reset"] },
      "password-reset:theirs",
    );
    await deliverAll();

    for (const statement of statements) await db.execute(sql.raw(statement));

    const legacy = await byTag("password-reset");
    expect(legacy.bodyWithheld).toBe("a password reset link");
    expect(legacy.bodyKey).toBeNull();
    expect((await loadBody(legacy, 45)).state).toBe("withheld");

    const theirs = await messageRow(tenantMessage.id);
    expect(theirs.bodyWithheld).toBeNull();
    expect(theirs.bodyKey).not.toBeNull();
    const stored = await readBody(Buffer.from(theirs.bodyKey!, "base64"), theirs.storageKey!);
    expect(stored.html).toContain("Hi");
  });
});
