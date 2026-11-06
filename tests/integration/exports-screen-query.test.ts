import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains, messageEvents } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { listMessages, withFuzzySearch } from "@/lib/dashboard/messages";
import { countExportableMessages, iterateExportMessages } from "@/lib/exports/messages-query";
import { exportFiltersFromSearchParams } from "@/lib/exports/params";
import { reviveFilters } from "@/lib/messages/filters";
import { readMessagesQuery } from "@/lib/messages/query";
import { postgresSearch, setSearchProvider, type SearchProvider } from "@/lib/search";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const DAY = 24 * 60 * 60 * 1000;

let fixture: Fixture;
let ids: Record<"recent" | "old" | "retried" | "held" | "invoice", string>;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
  const scope = { organizationId: fixture.organizationId, domainId: fixture.domainId };
  const ago = (days: number) => new Date(Date.now() - days * DAY);
  ids = {
    recent: await seedMessage(scope, { createdAt: ago(1) }),
    old: await seedMessage(scope, { createdAt: ago(10) }),
    retried: await seedMessage(scope, { createdAt: ago(2), attempts: 2 }),
    held: await seedMessage(scope, { createdAt: ago(1), status: "queued" }),
    invoice: await seedMessage(scope, { createdAt: ago(3), subject: "Quarterly invoice" }),
  };
  await db.update(domains).set({ stalledAt: new Date(), stallReason: "bounce_rate" }).where(eq(domains.id, fixture.domainId));
});
afterEach(() => setSearchProvider(null));

const exported = async (query: string): Promise<string[]> => {
  const filters = await exportFiltersFromSearchParams(fixture.organizationId, new URLSearchParams(query));
  const rows: string[] = [];
  for await (const row of iterateExportMessages(fixture.organizationId, filters)) rows.push(row.message.id);
  return rows.sort();
};

/** What the messages screen lists for the same query string. */
const shown = async (query: string): Promise<string[]> => {
  const params = Object.fromEntries(new URLSearchParams(query));
  const { filters } = await withFuzzySearch(fixture.organizationId, readMessagesQuery(params).filters);
  return (await listMessages(fixture.organizationId, filters)).map((row) => row.id).sort();
};

describe("an API export's filters", () => {
  it("stay open-ended without a since, and bound created_at with one", async () => {
    const all: string[] = [];
    for await (const row of iterateExportMessages(fixture.organizationId, {})) all.push(row.message.id);
    expect(all).toContain(ids.old);

    const since: string[] = [];
    for await (const row of iterateExportMessages(fixture.organizationId, { since: new Date(Date.now() - 5 * DAY) })) {
      since.push(row.message.id);
    }
    expect(since).not.toContain(ids.old);
    expect(since).toContain(ids.invoice);
  });
});

describe("an export of the messages screen's query", () => {
  it("holds the default seven-day window, not all time", async () => {
    const rows = await exported("");
    expect(rows).not.toContain(ids.old);
    expect(rows).toContain(ids.recent);
  });

  it("reaches as far back as the screen's days param", async () => {
    expect(await exported("days=30")).toContain(ids.old);
    expect(await exported("days=2")).not.toContain(ids.invoice);
  });

  it("holds the held preset to queued mail a stall is keeping", async () => {
    expect(await exported("preset=held")).toEqual([ids.held]);
  });

  it("holds the retried filter to messages that took more than one attempt", async () => {
    expect(await exported("retried=1")).toEqual([ids.retried]);
  });

  it("lists and exports the messages a bounce reason names, as the overview links them", async () => {
    await db.insert(messageEvents).values({
      id: newId("event"),
      organizationId: fixture.organizationId,
      messageId: ids.recent,
      status: "bounced",
      reason: "552 mailbox full",
    });
    const query = "reason=552+mailbox+full";
    expect(await shown(query)).toEqual([ids.recent]);
    expect(await exported(query)).toEqual([ids.recent]);
  });

  it("counts what it will stream", async () => {
    const filters = await exportFiltersFromSearchParams(fixture.organizationId, new URLSearchParams("preset=held"));
    expect(await countExportableMessages(fixture.organizationId, filters)).toBe(1);
  });

  it("carries the ids a typo-tolerant search matched", async () => {
    const fuzzy: SearchProvider = {
      ...postgresSearch,
      mode: "meilisearch",
      search: async () => ({ mode: "meilisearch", hits: [{ id: ids.invoice, matched: {} }], degraded: false }),
    };
    setSearchProvider(fuzzy);
    expect(await exported("q=invoyce")).toEqual([ids.invoice]);
  });

  it("falls back to exact matches when the index is down, as the screen does", async () => {
    setSearchProvider({
      ...postgresSearch,
      mode: "meilisearch",
      search: async () => ({ mode: "meilisearch", hits: [], degraded: true }),
    });
    expect(await exported("q=invoyce")).toEqual([]);
    expect(await exported("q=invoice")).toEqual([ids.invoice]);
  });

  it("survives a queued job's JSON round trip", async () => {
    const filters = await exportFiltersFromSearchParams(fixture.organizationId, new URLSearchParams("days=30&retried=1"));
    const stored = JSON.parse(JSON.stringify(filters)) as Record<string, unknown>;
    const rows: string[] = [];
    for await (const row of iterateExportMessages(fixture.organizationId, reviveFilters(stored))) rows.push(row.message.id);
    expect(rows).toEqual([ids.retried]);
  });

  it.each(["", "days=30", "preset=held", "retried=1", "preset=attention&days=14", "status=delivered&days=3", "status=sent"])(
    "matches what the screen shows for %j",
    async (query) => {
      expect(await exported(query)).toEqual(await shown(query));
    },
  );
});
