import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, suppressions } from "@/lib/db/schema";
import { listSuppressions } from "@/lib/dashboard/suppressions";
import { listMessages, withFuzzySearch } from "@/lib/dashboard/messages";
import { listRecipients } from "@/lib/lists/recipients";
import { acceptMessage } from "@/lib/messages/create";
import { suppress } from "@/lib/messages/suppression";
import { removeSuppression } from "@/lib/messages/suppression-manage";
import { deleteOrganization } from "@/lib/organizations/delete";
import { userActor, workerActor } from "@/lib/activity/record";
import { newId } from "@/lib/ids";
import { postgresSearch, searchProvider, setSearchProvider, settleSearchWrites, type SearchProvider } from "@/lib/search";
import { MeilisearchProvider, filterValue, meilisearchConfig, searchFilter } from "@/lib/search/meilisearch";
import { SEARCH_INDEXES } from "@/lib/search/documents";
import { reindex } from "@/lib/search/reindex";
import { checkoutTag } from "../database-url";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const ACTOR = userActor("usr_test", "Ada");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => setSearchProvider(null));

const addresses = async (organizationId: string, search: string) =>
  (await listSuppressions(organizationId, { search })).rows.map((row) => row.address).sort();

async function suppressAll(organizationId: string, list: string[]): Promise<void> {
  for (const address of list) await suppress({ organizationId, address, reason: "hard_bounce" });
}

describe("search configuration", () => {
  it("is off until MEILISEARCH_URL is set", () => {
    expect(meilisearchConfig({})).toBeNull();
    expect(meilisearchConfig({ MEILISEARCH_URL: "https://search.example.com/" })?.url).toBe("https://search.example.com");
  });

  it("scopes every search to the organization, with the value escaped", () => {
    expect(filterValue('org_"x\\')).toBe('"org_\\"x\\\\"');
    expect(searchFilter({ organizationId: 'org_a" OR organization_id != "' })).toBe(
      'organization_id = "org_a\\" OR organization_id != \\""',
    );
  });
});

describe("search fallback", () => {
  it("answers from Postgres when Meilisearch refuses the connection", async () => {
    setSearchProvider(new MeilisearchProvider({ url: "http://127.0.0.1:9", apiKey: null, indexPrefix: "pouch_", timeoutMs: 500 }));
    await suppressAll(fixture.organizationId, ["ada.lovelace@example.net", "bob@example.net"]);

    const page = await listSuppressions(fixture.organizationId, { search: "lovelace" });
    expect(page.rows.map((row) => row.address)).toEqual(["ada.lovelace@example.net"]);
    expect(page.searchDegraded).toBe(true);
    expect(await addresses(fixture.organizationId, "lovelase")).toEqual([]);
  });

  it("stops waiting on a Meilisearch that hangs, then skips it for a while", async () => {
    const server: Server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      setSearchProvider(new MeilisearchProvider({ url: `http://127.0.0.1:${port}`, apiKey: null, indexPrefix: "pouch_", timeoutMs: 150 }));
      await suppressAll(fixture.organizationId, ["ada.lovelace@example.net"]);

      let started = Date.now();
      expect(await addresses(fixture.organizationId, "lovelace")).toEqual(["ada.lovelace@example.net"]);
      expect(Date.now() - started).toBeLessThan(1500);

      started = Date.now();
      const again = await listSuppressions(fixture.organizationId, { search: "lovelace" });
      expect(again.searchDegraded).toBe(true);
      expect(Date.now() - started).toBeLessThan(140);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("accepts a send while the index is down", async () => {
    setSearchProvider(new MeilisearchProvider({ url: "http://127.0.0.1:9", apiKey: null, indexPrefix: "pouch_", timeoutMs: 100 }));

    const accepted = await acceptMessage(fixture.key, { from: "hi@example.com", to: ["sam@example.net"], subject: "Receipt", text: "Hi" }, null);
    await settleSearchWrites();

    expect(await db.select().from(messages).where(eq(messages.id, accepted.message.id))).toHaveLength(1);
  });

  it("never shows another organization's row, whatever the index answers", async () => {
    const other = await seedFixture();
    await suppressAll(other.organizationId, ["theirs@example.net"]);
    const [theirs] = await db.select().from(suppressions);
    const lying: SearchProvider = {
      ...postgresSearch,
      mode: "meilisearch",
      search: async () => ({ mode: "meilisearch", hits: [{ id: theirs!.id, matched: {} }], degraded: false }),
    };
    setSearchProvider(lying);

    expect(await addresses(fixture.organizationId, "anything")).toEqual([]);
  });

  it("leaves search to Postgres with nothing configured", async () => {
    expect(searchProvider().mode).toBe("postgres");
    await suppressAll(fixture.organizationId, ["ada.lovelace@example.net"]);
    expect(await addresses(fixture.organizationId, "lovelace")).toEqual(["ada.lovelace@example.net"]);
    expect(await addresses(fixture.organizationId, "lovelase")).toEqual([]);
  });
});

const live = process.env.TEST_MEILISEARCH_URL;

describe.skipIf(!live)("search against Meilisearch", () => {
  const config = {
    url: live ?? "",
    apiKey: process.env.TEST_MEILISEARCH_API_KEY ?? null,
    indexPrefix: `pouch_test_${checkoutTag()}_`,
    timeoutMs: 5000,
  };
  let provider: MeilisearchProvider;

  async function settled(): Promise<void> {
    await settleSearchWrites();
    const headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : undefined;
    const uids = SEARCH_INDEXES.map((index) => provider.uid(index)).join(",");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${config.url}/tasks?statuses=enqueued,processing&indexUids=${uids}&limit=1`, { headers });
      const body = (await response.json()) as { total: number };
      if (body.total === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Meilisearch tasks didn't settle");
  }

  beforeAll(async () => {
    provider = new MeilisearchProvider(config);
    for (const index of SEARCH_INDEXES) await provider.clear(index);
  });

  beforeEach(async () => {
    setSearchProvider(provider);
    for (const index of SEARCH_INDEXES) await provider.clear(index);
    await settled();
  });

  it("finds a suppressed address through a typo", async () => {
    await suppressAll(fixture.organizationId, ["ada.lovelace@example.net", "bob@example.net"]);
    await settled();

    const page = await listSuppressions(fixture.organizationId, { search: "lovelase" });
    expect(page.rows.map((row) => row.address)).toEqual(["ada.lovelace@example.net"]);
    expect(page.searchDegraded).toBe(false);
  });

  it("keeps each organization to its own documents", async () => {
    const other = await seedFixture();
    await suppressAll(fixture.organizationId, ["ada.lovelace@example.net"]);
    await suppressAll(other.organizationId, ["ada.lovelace@example.org", "lovelace@example.com"]);
    await settled();

    const theirs = new Set((await db.select().from(suppressions).where(eq(suppressions.organizationId, other.organizationId))).map((row) => row.id));
    const hits = await provider.search("suppressions", { organizationId: fixture.organizationId, term: "lovelace" });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits.some((hit) => theirs.has(hit.id))).toBe(false);

    expect(await addresses(fixture.organizationId, "lovelase")).toEqual(["ada.lovelace@example.net"]);
    expect(await addresses(other.organizationId, "lovelase")).toEqual(["ada.lovelace@example.org", "lovelace@example.com"]);
  });

  it("finds a message through a typo in its subject, and a recipient without the others on the message", async () => {
    await acceptMessage(fixture.key, { from: "hi@example.com", to: ["sam@example.net", "ada.lovelace@example.net"], subject: "Quarterly statement", text: "Hi" }, null);
    await acceptMessage(fixture.key, { from: "hi@example.com", to: ["bob@example.net"], subject: "Password reset", text: "Hi" }, null);
    await settled();

    const { filters } = await withFuzzySearch(fixture.organizationId, { search: "quartely" });
    expect((await listMessages(fixture.organizationId, filters)).map((row) => row.subject)).toEqual(["Quarterly statement"]);

    const recipients = await listRecipients(fixture.organizationId, { search: "lovelase" });
    expect(recipients.rows.map((row) => row.address)).toEqual(["ada.lovelace@example.net"]);
  });

  it("drops a removed suppression and a deleted organization from the index", async () => {
    await suppressAll(fixture.organizationId, ["ada.lovelace@example.net", "bob@example.net"]);
    await seedMessage(fixture, { to: "sam@example.net", subject: "Quarterly statement" });
    await reindex(provider);
    await settled();

    await removeSuppression(fixture.organizationId, "ada.lovelace@example.net", ACTOR);
    await settled();
    expect((await provider.search("suppressions", { organizationId: fixture.organizationId, term: "lovelace" })).hits).toEqual([]);

    await deleteOrganization(fixture.organizationId, workerActor());
    await settled();
    expect((await provider.search("suppressions", { organizationId: fixture.organizationId, term: "bob" })).hits).toEqual([]);
    expect((await provider.search("messages", { organizationId: fixture.organizationId, term: "quarterly" })).hits).toEqual([]);
  });

  it("fills the index from Postgres, and a fresh run drops what Postgres no longer has", async () => {
    await suppressAll(fixture.organizationId, ["ada.lovelace@example.net"]);
    await settled();
    await db.insert(suppressions).values({ id: newId("suppression"), organizationId: fixture.organizationId, address: "grace.hopper@example.net", reason: "manual" });
    await db.delete(suppressions).where(eq(suppressions.address, "ada.lovelace@example.net"));

    expect(await reindex(provider)).toEqual({ messages: 0, suppressions: 1 });
    await settled();
    expect(await addresses(fixture.organizationId, "hoper")).toEqual(["grace.hopper@example.net"]);
    expect((await provider.search("suppressions", { organizationId: fixture.organizationId, term: "lovelace" })).hits).toHaveLength(1);

    await reindex(provider, { fresh: true });
    await settled();
    expect((await provider.search("suppressions", { organizationId: fixture.organizationId, term: "lovelace" })).hits).toEqual([]);
  });
});
