import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { messages, suppressions } from "@/lib/db/schema";
import { listSuppressions, readSuppressionDetail, readSuppressionSummary } from "@/lib/dashboard/suppressions";
import { SUPPRESSION_TREND_DAYS, SUPPRESSIONS_PAGE_SIZE } from "@/lib/dashboard/views/suppressions";
import { addSuppression, removeSuppression } from "@/lib/messages/suppression-manage";
import { acceptMessage } from "@/lib/messages/create";
import { suppress, findSuppressed } from "@/lib/messages/suppression";
import { newId } from "@/lib/ids";
import { userActor } from "@/lib/activity/record";
import { eq } from "drizzle-orm";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const ACTOR = userActor("usr_test", "Ada");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

const send = (to: string) =>
  acceptMessage(fixture.key, { from: "hi@example.com", to: [to], subject: "Hi", html: "<p>Hi</p>" }, null);

describe("addSuppression", () => {
  it("normalizes the domain part and preserves the local part", async () => {
    const stored = await addSuppression(fixture.organizationId, "  Sam@EXAMPLE.COM ", "By phone", ACTOR);
    expect(stored).toBe("Sam@example.com");

    const [row] = await db.select().from(suppressions);
    expect(row?.address).toBe("Sam@example.com");
    expect(row?.reason).toBe("manual");
    expect(row?.detail).toBe("By phone");
  });

  it("stops a send to the address it just added", async () => {
    await expect(send("Sam@example.com")).resolves.toBeTruthy();
    await addSuppression(fixture.organizationId, "Sam@example.com", null, ACTOR);
    await expect(send("Sam@EXAMPLE.com")).rejects.toMatchObject({ code: "recipient_suppressed" });
  });

  it.each([
    {
      name: "an address already on the list",
      address: "sam@example.com",
      seed: () => addSuppression(fixture.organizationId, "sam@example.com", null, ACTOR),
      rows: 1,
      field: undefined,
    },
    { name: "something that isn't an address", address: "not-an-address", seed: async () => {}, rows: 0, field: "address" },
    {
      name: "a mailbox that already has a bounce",
      address: "sam@EXAMPLE.com",
      seed: () => suppress({ organizationId: fixture.organizationId, address: "sam@example.com", reason: "hard_bounce" }),
      rows: 1,
      field: undefined,
    },
  ])("refuses $name rather than adding a row", async ({ address, seed, rows, field }) => {
    await seed();
    await expect(addSuppression(fixture.organizationId, address, null, ACTOR)).rejects.toMatchObject({
      code: "validation_failed",
      ...(field ? { field } : {}),
    });
    expect(await db.select().from(suppressions)).toHaveLength(rows);
  });
});

describe("removeSuppression", () => {
  it("lets sends through again", async () => {
    await addSuppression(fixture.organizationId, "sam@example.com", null, ACTOR);
    await removeSuppression(fixture.organizationId, "SAM@EXAMPLE.com".replace("SAM", "sam"), ACTOR);
    expect(await findSuppressed(fixture.organizationId, ["sam@example.com"])).toEqual([]);
    await expect(send("sam@example.com")).resolves.toBeTruthy();
  });

  it("won't remove another organization's row", async () => {
    const other = await seedFixture();
    await addSuppression(other.organizationId, "sam@example.com", null, ACTOR);

    await expect(removeSuppression(fixture.organizationId, "sam@example.com", ACTOR)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await findSuppressed(other.organizationId, ["sam@example.com"])).toHaveLength(1);
  });

  it("says so when the address was never on the list", async () => {
    await expect(removeSuppression(fixture.organizationId, "nobody@example.com", ACTOR)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("listSuppressions", () => {
  it("names the message that caused it, and admits when there wasn't one", async () => {
    const messageId = newId("message");
    await db.insert(messages).values({
      id: messageId,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      status: "bounced",
      fromAddress: "hi@example.com",
      recipients: ["gone@example.com"],
      subject: "Invoice 2041",
      envelope: {
        from: "hi@example.com",
        fromName: null,
        to: ["gone@example.com"],
        cc: [],
        bcc: [],
        replyTo: [],
        headers: {},
        attachmentCount: 0,
      },
      tags: [],
    });
    await suppress({
      organizationId: fixture.organizationId,
      address: "gone@example.com",
      reason: "hard_bounce",
      detail: "550 5.1.1 User unknown.",
      sourceMessageId: messageId,
    });
    await addSuppression(fixture.organizationId, "byhand@example.com", "Asked by phone", ACTOR);

    const { rows } = await listSuppressions(fixture.organizationId);
    const byAddress = new Map(rows.map((row) => [row.address, row]));
    expect(byAddress.get("gone@example.com")?.source).toEqual({
      id: messageId,
      subject: "Invoice 2041",
      domainName: "example.com",
    });
    expect(byAddress.get("byhand@example.com")?.source).toBeNull();
    expect(byAddress.get("byhand@example.com")?.detail).toBe("Asked by phone");
  });

  it("shows only this organization's list", async () => {
    const other = await seedFixture();
    await addSuppression(fixture.organizationId, "ours@example.com", null, ACTOR);
    await addSuppression(other.organizationId, "theirs@example.com", null, ACTOR);

    expect((await listSuppressions(fixture.organizationId)).rows.map((row) => row.address)).toEqual([
      "ours@example.com",
    ]);
  });

  it("filters by address", async () => {
    await addSuppression(fixture.organizationId, "one@cedarvine.com", null, ACTOR);
    await addSuppression(fixture.organizationId, "two@example.com", null, ACTOR);

    expect(
      (await listSuppressions(fixture.organizationId, { search: "cedarvine" })).rows.map((row) => row.address),
    ).toEqual(["one@cedarvine.com"]);
  });
});

describe("listSuppressions at scale", () => {
  /** The screen most likely to hold thousands of rows, each with a Remove button to tab past. */
  async function seedMany(count: number) {
    await db.insert(suppressions).values(
      Array.from({ length: count }, (_, index) => ({
        id: newId("suppression"),
        organizationId: fixture.organizationId,
        address: `bulk-${String(index).padStart(4, "0")}@example.com`,
        reason: "manual" as const,
      })),
    );
  }

  it("returns one page and the full count, not every row", async () => {
    await seedMany(120);

    const first = await listSuppressions(fixture.organizationId);
    expect(first.rows).toHaveLength(SUPPRESSIONS_PAGE_SIZE);
    expect(first.total).toBe(120);
    expect(first.page).toBe(1);
    expect(first.pageCount).toBe(3);
  });

  it("walks pages without repeating or skipping a row", async () => {
    await seedMany(120);

    const seen = new Set<string>();
    for (let page = 1; page <= 3; page += 1) {
      const result = await listSuppressions(fixture.organizationId, { page });
      expect(result.page).toBe(page);
      for (const row of result.rows) seen.add(row.address);
    }
    expect(seen.size).toBe(120);
  });

  it("clamps a page past the end rather than showing nothing", async () => {
    await seedMany(60);

    const result = await listSuppressions(fixture.organizationId, { page: 99 });
    expect(result.page).toBe(2);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("counts the filter's matches, not the whole list", async () => {
    await seedMany(60);
    await addSuppression(fixture.organizationId, "needle@cedarvine.com", null, ACTOR);

    const result = await listSuppressions(fixture.organizationId, { search: "cedarvine" });
    expect(result.total).toBe(1);
    expect(result.pageCount).toBe(1);
    expect(result.rows.map((row) => row.address)).toEqual(["needle@cedarvine.com"]);
  });
});

describe("listSuppressions filters", () => {
  it("narrows by reason, by the domain that sent the cause and by the day it was added", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    const onFirst = await seedMessage(fixture, { to: "a@example.net", status: "bounced" });
    const onSecond = await seedMessage({ ...fixture, domainId: second.domainId }, { to: "b@example.net", status: "complained" });
    await suppress({ organizationId: fixture.organizationId, address: "a@example.net", reason: "hard_bounce", sourceMessageId: onFirst });
    await suppress({ organizationId: fixture.organizationId, address: "b@example.net", reason: "complaint", sourceMessageId: onSecond });
    await addSuppression(fixture.organizationId, "c@example.net", null, ACTOR);
    await db.update(suppressions).set({ createdAt: new Date("2026-03-04T23:59:00Z") }).where(eq(suppressions.address, "c@example.net"));

    const addresses = async (filters: Parameters<typeof listSuppressions>[1]) =>
      (await listSuppressions(fixture.organizationId, filters)).rows.map((row) => row.address).sort();

    expect(await addresses({ reason: "complaint" })).toEqual(["b@example.net"]);
    expect(await addresses({ domain: "second.example.com" })).toEqual(["b@example.net"]);
    expect(await addresses({ domain: "nowhere.example" })).toEqual([]);
    expect(await addresses({ from: "2026-03-04", to: "2026-03-04" })).toEqual(["c@example.net"]);
    expect(await addresses({ from: "2026-03-05" })).toEqual(["a@example.net", "b@example.net"]);
  });

  it("matches a search's underscore and percent literally", async () => {
    await addSuppression(fixture.organizationId, "a_b@example.com", null, ACTOR);
    await addSuppression(fixture.organizationId, "axb@example.com", null, ACTOR);

    expect((await listSuppressions(fixture.organizationId, { search: "a_b" })).rows.map((row) => row.address)).toEqual([
      "a_b@example.com",
    ]);
  });
});

describe("readSuppressionDetail", () => {
  it("links the cause, the address's other incidents and its whole send history", async () => {
    const delivered = await seedMessage(fixture, { to: "gone@example.net", status: "delivered", subject: "Welcome" });
    const earlier = await seedMessage(fixture, { to: "gone@example.net", status: "bounced", subject: "Receipt" });
    const cause = await seedMessage(fixture, { to: "gone@example.net", status: "bounced", subject: "Invoice 2041" });
    await seedMessage(fixture, { to: "someone@example.net", subject: "Not theirs" });
    await suppress({
      organizationId: fixture.organizationId,
      address: "gone@example.net",
      reason: "hard_bounce",
      detail: "550 5.1.1 User unknown.",
      bounceType: "Permanent/NoEmail",
      sourceMessageId: cause,
    });
    const [row] = await db.select().from(suppressions);

    const detail = await readSuppressionDetail(fixture.organizationId, row!.id);

    expect(detail).toMatchObject({
      address: "gone@example.net",
      reason: "hard_bounce",
      bounceType: "Permanent/NoEmail",
      detail: "550 5.1.1 User unknown.",
      cause: { id: cause, subject: "Invoice 2041", domainName: "example.com" },
      historyTotal: 3,
    });
    expect(detail?.history.map((item) => item.id).sort()).toEqual([cause, delivered, earlier].sort());
    expect(detail?.incidents.map((item) => item.id).sort()).toEqual([cause, earlier].sort());
  });

  it("names who added a manual one", async () => {
    await addSuppression(fixture.organizationId, "byhand@example.com", "By phone", ACTOR);
    const [row] = await db.select().from(suppressions);

    expect(await readSuppressionDetail(fixture.organizationId, row!.id)).toMatchObject({ addedBy: "Ada", cause: null });
  });

  it("finds nothing for another organization's id, or for an address in place of an id", async () => {
    const other = await seedFixture();
    await addSuppression(other.organizationId, "theirs@example.com", null, ACTOR);
    const [row] = await db.select().from(suppressions);

    expect(await readSuppressionDetail(fixture.organizationId, row!.id)).toBeNull();
    expect(await readSuppressionDetail(other.organizationId, "theirs@example.com")).toBeNull();
    expect(await readSuppressionDetail(other.organizationId, row!.id)).not.toBeNull();
  });
});

describe("readSuppressionSummary", () => {
  it("counts the list by reason, largest first, and additions per UTC day in the window", async () => {
    const now = new Date("2026-09-29T12:00:00Z");
    await suppress({ organizationId: fixture.organizationId, address: "a@example.net", reason: "hard_bounce" });
    await suppress({ organizationId: fixture.organizationId, address: "b@example.net", reason: "hard_bounce" });
    await addSuppression(fixture.organizationId, "c@example.net", null, ACTOR);
    await db.update(suppressions).set({ createdAt: new Date("2026-09-29T01:00:00Z") }).where(eq(suppressions.address, "a@example.net"));
    await db.update(suppressions).set({ createdAt: new Date("2026-08-31T00:00:00Z") }).where(eq(suppressions.address, "b@example.net"));
    await db.update(suppressions).set({ createdAt: new Date("2026-08-01T00:00:00Z") }).where(eq(suppressions.address, "c@example.net"));
    const other = await seedFixture();
    await suppress({ organizationId: other.organizationId, address: "d@example.net", reason: "complaint" });

    const summary = await readSuppressionSummary(fixture.organizationId, "UTC", now);
    expect(summary.byReason).toEqual([
      { reason: "hard_bounce", count: 2 },
      { reason: "manual", count: 1 },
    ]);
    expect(summary.days).toHaveLength(SUPPRESSION_TREND_DAYS);
    expect(summary.days[0]).toBe("2026-08-31");
    expect(summary.days.at(-1)).toBe("2026-09-29");
    expect(summary.added[0]).toBe(1);
    expect(summary.added.at(-1)).toBe(1);
    expect(summary.added.reduce((total, value) => total + value, 0)).toBe(2);
  });
});
