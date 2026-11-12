/** System mail is the service's own (#579): the organization holding the system from domain carries it and can't read it. */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, memberships, messageEvents, messageHourlyStats, messageStatsRollup, messages, suppressions, users } from "@/lib/db/schema";
import { readMessage, listMessages as listDashboardMessages } from "@/lib/dashboard/messages";
import { messagesCsvLines } from "@/lib/exports/log";
import { newId } from "@/lib/ids";
import { sendSystemMail } from "@/lib/mail/system";
import { SystemMail } from "@/lib/mail/template";
import { acceptDashboardMessage } from "@/lib/messages/create";
import { applyEvent } from "@/lib/messages/events";
import { listMessages as listApiMessages } from "@/lib/messages/list";
import { findMessage } from "@/lib/messages/read";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { sendNotification } from "@/lib/notifications/send";
import { setSystemFromAddress } from "@/lib/settings/service";
import { listServiceMail, listServiceSuppressions, removeServiceSuppression } from "@/lib/system/service-mail";
import { adminActor } from "@/lib/activity/record";
import { dbNow } from "@/lib/db/clock";
import { deleteDomain } from "@/lib/domains";
import { rollupMessageStats } from "@/lib/stats/rollup";
import { deliver } from "@/worker/send";
import { messageRow, resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { withSchema } from "./migration-replay";

/** The organization that verified the system from domain: its members are the ones who could read system mail before. */
let carrier: Fixture;
/** Another organization, whose owner gets a notification. */
let other: Fixture;
let ownerEmail: string;

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

async function deliverAll(): Promise<void> {
  for (const provider of await dueProviders()) {
    for (const item of await claimMessages({ workerId: "worker-test", providerId: provider.id, limit: 10 })) await deliver(item);
  }
}

async function notifyOther(): Promise<string> {
  const result = await sendNotification({
    type: "dmarc_policy_ready",
    organizationId: other.organizationId,
    input: { domainName: "other.example.com", days: 30, record: { name: "_dmarc.other.example.com", value: "v=DMARC1; p=quarantine" }, url: "https://pouch.example/domains" },
    key: "other-domain:1",
  });
  expect(result.sent).toBe(1);
  const [row] = await db.select().from(messages).where(sql`${messages.recipients} @> array[${ownerEmail}]::text[]`);
  return row!.id;
}

/** What a member of the carrier reads, through the dashboard list and detail, the API list and read, and the CSV export. */
async function carrierReads(id: string) {
  const caller = { organizationId: carrier.organizationId, domainIds: [], mode: "live" as const };
  const api = await listApiMessages(caller, 100);
  const csv = (await collect(messagesCsvLines(carrier.organizationId, {}))).join("");
  return {
    dashboardList: (await listDashboardMessages(carrier.organizationId)).some((row) => row.id === id),
    dashboardDetail: (await readMessage(carrier.organizationId, id)) !== null,
    apiList: api.data.some((row) => row.id === id),
    apiRead: await findMessage(caller, id).then(
      () => true,
      () => false,
    ),
    export: csv.includes(id),
  };
}

beforeEach(async () => {
  await resetDatabase();
  carrier = await seedFixture();
  await db.update(domains).set({ name: "mail.example.org" }).where(eq(domains.id, carrier.domainId));
  await setSystemFromAddress("support@mail.example.org");

  other = await seedFixture();
  await db.update(domains).set({ name: "other.example.com" }).where(eq(domains.id, other.domainId));
  const userId = crypto.randomUUID();
  ownerEmail = `owner-${userId.slice(0, 8)}@other.example.com`;
  await db.insert(users).values({ id: userId, organizationId: other.organizationId, name: "Owner", email: ownerEmail });
  await db.insert(memberships).values({ id: newId("membership"), userId, organizationId: other.organizationId, role: "owner" });
});

describe("another organization's notification", () => {
  it("goes out through the carrier's domain and provider", async () => {
    const id = await notifyOther();
    await deliverAll();

    const row = await messageRow(id);
    expect(row.organizationId).toBeNull();
    expect(row.domainId).toBe(carrier.domainId);
    expect(row.status).toBe("sent");
    expect(row.providerId).toBe(carrier.providerId);
  });

  it("isn't in the carrier's list, API or export", async () => {
    const id = await notifyOther();
    await deliverAll();

    expect(await carrierReads(id)).toEqual({ dashboardList: false, dashboardDetail: false, apiList: false, apiRead: false, export: false });
  });

  it("control: the carrier's own message is in every one of those reads", async () => {
    const { message } = await acceptDashboardMessage(carrier.organizationId, {
      from: "hello@mail.example.org",
      to: ["person@example.net"],
      subject: "Our own",
      html: "<p>Hi</p>",
    });
    await deliverAll();

    expect(await carrierReads(message.id)).toEqual({ dashboardList: true, dashboardDetail: true, apiList: true, apiRead: true, export: true });
  });

  it("is in Admin's service mail list", async () => {
    const id = await notifyOther();

    const page = await listServiceMail();
    expect(page.rows.find((row) => row.id === id)).toMatchObject({ to: [ownerEmail], domainName: "mail.example.org", status: "queued" });
  });

  it("keeps its events out of the carrier's", async () => {
    const id = await notifyOther();
    await deliverAll();

    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    expect(events.map((event) => event.status)).toEqual(expect.arrayContaining(["queued", "sent"]));
    expect(events.every((event) => event.organizationId === null)).toBe(true);
  });
});

describe("a bounce on system mail", () => {
  async function bounce(id: string): Promise<void> {
    const row = await messageRow(id);
    const result = await applyEvent(
      { id: carrier.providerId, organizationId: carrier.organizationId },
      {
        providerMessageId: row.providerMessageId!,
        providerEventId: "bounce-1",
        status: "bounced",
        reason: "550 5.1.1 Mailbox does not exist",
        bounceType: "Permanent/NoEmail",
        occurredAt: new Date(),
        detail: {},
        recipients: [ownerEmail],
      },
    );
    expect(result.outcome).toBe("recorded");
  }

  it("moves the message and suppresses the address for system mail only", async () => {
    const id = await notifyOther();
    await deliverAll();
    await bounce(id);

    expect((await messageRow(id)).status).toBe("bounced");
    const rows = await db.select().from(suppressions).where(eq(suppressions.address, ownerEmail));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: null, reason: "hard_bounce", sourceMessageId: id });
    expect((await listServiceSuppressions()).map((row) => row.address)).toEqual([ownerEmail]);
  });

  it("stops the next system mail to the address, until an operator removes it", async () => {
    const id = await notifyOther();
    await deliverAll();
    await bounce(id);

    const send = () =>
      sendSystemMail({
        to: ownerEmail,
        subject: "Again",
        email: createElement(SystemMail, { heading: "Again", paragraphs: ["Hello."], reason: "Testing." }),
        tags: ["system-alert"],
        idempotencyKey: `again:${crypto.randomUUID()}`,
      });
    await expect(send()).rejects.toThrow(/Recipient is suppressed/);

    await removeServiceSuppression(ownerEmail, adminActor("admin-1", "Admin"));
    await expect(send()).resolves.toBeUndefined();
  });

  it("leaves the carrier's own list and recipient history alone", async () => {
    const id = await notifyOther();
    await deliverAll();
    await bounce(id);

    const carrierRows = await db.select().from(suppressions).where(eq(suppressions.organizationId, carrier.organizationId));
    expect(carrierRows).toEqual([]);
    const { message } = await acceptDashboardMessage(carrier.organizationId, {
      from: "hello@mail.example.org",
      to: [ownerEmail],
      subject: "Carrier's own",
      html: "<p>Hi</p>",
    });
    expect(message.warnings).toEqual([]);
  });
});

describe("deleting a domain that carried system mail", () => {
  const caller = () => ({ organizationId: carrier.organizationId, domainIds: [], actor: adminActor("admin-1", "Admin") });
  const moveSystemMail = () => setSystemFromAddress("support@other.example.com");

  it("goes, and takes the sent system mail with it", async () => {
    const id = await notifyOther();
    await deliverAll();
    await moveSystemMail();

    await expect(deleteDomain(caller(), carrier.domainId)).resolves.toMatchObject({ deleted: true });
    expect(await db.select().from(messages).where(eq(messages.id, id))).toEqual([]);
  });

  it("is refused while the system from address names it", async () => {
    await notifyOther();
    await deliverAll();

    await expect(deleteDomain(caller(), carrier.domainId)).rejects.toThrow(/sends system mail/);
  });

  it("is refused while system mail on it waits to send", async () => {
    await notifyOther();
    await moveSystemMail();

    await expect(deleteDomain(caller(), carrier.domainId)).rejects.toThrow(/waiting to send/);
  });

  it("takes the organization's own sent mail with it too", async () => {
    await acceptDashboardMessage(carrier.organizationId, { from: "hello@mail.example.org", to: ["person@example.net"], subject: "Ours", html: "<p>Hi</p>" });
    await deliverAll();
    await moveSystemMail();

    await expect(deleteDomain(caller(), carrier.domainId)).resolves.toMatchObject({ deleted: true });
  });
});

describe("the migration that moves system mail out of the carrier", () => {
  const statements = readFileSync("drizzle/0086_service_mail.sql", "utf8")
    .split("--> statement-breakpoint")
    .filter((statement) => !/CREATE (UNIQUE )?INDEX/.test(statement));

  it("applies in order, unique indexes first, when two organizations carried the same key and suppressed the same address", async () => {
    await notifyOther();
    await deliverAll();
    const [legacy] = await db.select().from(messages).where(sql`${messages.recipients} @> array[${ownerEmail}]::text[]`);
    // Sent as before #579, once by each organization that held the system from domain in turn.
    await db.update(messages).set({ organizationId: carrier.organizationId }).where(eq(messages.id, legacy!.id));
    const twinId = newId("message");
    await db.insert(messages).values({ ...legacy!, id: twinId, organizationId: other.organizationId, domainId: other.domainId, providerId: null, createdAt: new Date(legacy!.createdAt.getTime() + 1000) });
    for (const [organizationId, sourceMessageId] of [[carrier.organizationId, legacy!.id], [other.organizationId, twinId]] as const) {
      await db.insert(suppressions).values({ id: newId("suppression"), organizationId, address: ownerEmail, reason: "hard_bounce", sourceMessageId });
    }
    const all = readFileSync("drizzle/0086_service_mail.sql", "utf8").split("--> statement-breakpoint");

    await withSchema(
      ['DROP INDEX "messages_service_idempotency_idx"', 'DROP INDEX "messages_service_created_idx"', 'DROP INDEX "suppressions_service_address_idx"'],
      async (tx) => {
        for (const statement of all) await tx.execute(sql.raw(statement));

        const moved = await tx.select().from(messages).where(sql`${messages.id} in (${legacy!.id}, ${twinId})`);
        expect(moved.every((row) => row.organizationId === null)).toBe(true);
        expect(moved.find((row) => row.id === twinId)?.idempotencyKey).toBe(legacy!.idempotencyKey);
        expect(moved.find((row) => row.id === legacy!.id)?.idempotencyKey).toBeNull();
        const kept = await tx.select().from(suppressions).where(eq(suppressions.address, ownerEmail));
        expect(kept).toEqual([expect.objectContaining({ organizationId: null, sourceMessageId: legacy!.id })]);
      },
    );
  });

  /** Rolled-up message counts per organization, the service's under "service". */
  async function rolledTotals(): Promise<Record<string, number>> {
    const rows = await db.select().from(messageHourlyStats);
    const totals: Record<string, number> = {};
    for (const row of rows) totals[row.organizationId ?? "service"] = (totals[row.organizationId ?? "service"] ?? 0) + row.total;
    return totals;
  }

  it("redoes only the carrier's rolled-up hours that held system mail", async () => {
    await notifyOther();
    await acceptDashboardMessage(carrier.organizationId, { from: "hello@mail.example.org", to: ["person@example.net"], subject: "Ours", html: "<p>Hi</p>" });
    await acceptDashboardMessage(other.organizationId, { from: "hello@other.example.com", to: ["person@example.net"], subject: "Theirs", html: "<p>Hi</p>" });
    await deliverAll();
    const service = await db.select().from(messages).where(isNull(messages.organizationId));
    // Sent as before #579, three days ago so the rollup holds the hour.
    await db.execute(sql`update ${messages} set created_at = now() - interval '3 days', updated_at = now() - interval '3 days', organization_id = coalesce(organization_id, ${carrier.organizationId})`);
    await db.execute(sql`update ${messageEvents} set organization_id = coalesce(organization_id, ${carrier.organizationId})`);

    await rollupMessageStats(await dbNow());
    expect(await rolledTotals()).toEqual({ [carrier.organizationId]: 1 + service.length, [other.organizationId]: 1 });
    const [state] = await db.select().from(messageStatsRollup);

    await db.transaction(async (tx) => {
      for (const statement of statements) await tx.execute(sql.raw(statement));
    });
    expect(await rolledTotals()).toEqual({ [other.organizationId]: 1 });
    expect(await db.select().from(messageStatsRollup)).toEqual([state]);

    await rollupMessageStats(await dbNow());
    expect(await rolledTotals()).toEqual({ [carrier.organizationId]: 1, [other.organizationId]: 1, service: service.length });
  });

  it("moves system mail, its events and its suppressions, and leaves the carrier's own mail", async () => {
    // Sent as before #579: held by the carrier.
    await notifyOther();
    await deliverAll();
    const [legacy] = await db.select().from(messages).where(isNull(messages.organizationId));
    await db.update(messages).set({ organizationId: carrier.organizationId }).where(eq(messages.id, legacy!.id));
    await db.update(messageEvents).set({ organizationId: carrier.organizationId }).where(eq(messageEvents.messageId, legacy!.id));
    await db.insert(suppressions).values({
      id: newId("suppression"),
      organizationId: carrier.organizationId,
      address: ownerEmail,
      reason: "hard_bounce",
      sourceMessageId: legacy!.id,
    });

    const { message: dashboardTest } = await acceptDashboardMessage(carrier.organizationId, {
      from: "hello@mail.example.org",
      to: ["person@example.net"],
      subject: "Test",
      html: "<p>Hi</p>",
      tags: ["invitation"],
    });
    const { message: tenantKeyed } = await acceptDashboardMessage(
      carrier.organizationId,
      { from: "hello@mail.example.org", to: ["person@example.net"], subject: "Signup", html: "<p>Hi</p>", tags: ["list-confirmation"] },
      "list-confirm:abc",
    );

    await db.transaction(async (tx) => {
      for (const statement of statements) await tx.execute(sql.raw(statement));
    });

    expect((await messageRow(legacy!.id)).organizationId).toBeNull();
    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, legacy!.id));
    expect(events.every((event) => event.organizationId === null)).toBe(true);
    const [suppression] = await db.select().from(suppressions).where(eq(suppressions.address, ownerEmail));
    expect(suppression!.organizationId).toBeNull();

    expect((await messageRow(dashboardTest.id)).organizationId).toBe(carrier.organizationId);
    expect((await messageRow(tenantKeyed.id)).organizationId).toBe(carrier.organizationId);
  });
});
