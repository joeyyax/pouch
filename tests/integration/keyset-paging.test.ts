import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  activity,
  domains,
  exportJobs,
  inboundMessages,
  listMemberships,
  lists,
  messageEvents,
  messages,
  providers,
} from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { newId } from "@/lib/ids";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { GET as domainsGET } from "@/app/api/v1/domains/route";
import { GET as emailsGET } from "@/app/api/v1/emails/route";
import { GET as exportsGET } from "@/app/api/v1/exports/route";
import { GET as listsGET } from "@/app/api/v1/lists/route";
import { GET as membersGET } from "@/app/api/v1/lists/[id]/members/route";
import { GET as inboundGET } from "@/app/api/v1/inbound/route";
import { GET as providersGET } from "@/app/api/v1/providers/route";
import { iterateExportMessages } from "@/lib/exports/messages-query";
import { listActivity } from "@/lib/activity/query";
import { streamEventsForKey } from "@/lib/messages/stream";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

// Rows written in one statement share a timestamp down to the microsecond, which a JS Date can't hold.
const SHARED = "2026-09-01T12:00:00.123456Z";
const COUNT = 7;
const LIMIT = 3;

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});

async function share(table: string, column: string): Promise<void> {
  await db.execute(sql.raw(`update ${table} set ${column} = '${SHARED}' where organization_id = '${fixture.organizationId}'`));
}

function range(): number[] {
  return Array.from({ length: COUNT }, (_, i) => i);
}

async function seedMessages(): Promise<string[]> {
  const ids = range().map(() => newId("message"));
  await db.insert(messages).values(
    ids.map((id, i) => ({
      id,
      organizationId: fixture.organizationId,
      domainId: fixture.domainId,
      fromAddress: "hi@example.com",
      recipients: [`r${i}@example.net`],
      subject: `Message ${i}`,
      envelope: { from: "hi@example.com", fromName: null, to: [`r${i}@example.net`], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
    })),
  );
  await share("messages", "created_at");
  return ids;
}

type Route = (request: Request, context?: never) => Promise<Response>;

/** Pages a /v1 list route to the end and returns every id it gave. */
async function walk(route: Route, path: string, context?: unknown): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const separator = path.includes("?") ? "&" : "?";
    const url = `http://localhost${path}${separator}limit=${LIMIT}${cursor ? `&cursor=${cursor}` : ""}`;
    const response = await route(new Request(url, { headers: { authorization: `Bearer ${fixture.secret}` } }), context as never);
    expect(response.status, path).toBe(200);
    const body = (await response.json()) as { data: { id: string }[]; next_cursor: string | null };
    seen.push(...body.data.map((row) => row.id));
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  return seen;
}

function expectAll(seen: string[], ids: string[]): void {
  expect(seen).toHaveLength(ids.length);
  expect(new Set(seen)).toEqual(new Set(ids));
}

describe("cursor paging over rows that share a timestamp", () => {
  it("GET /v1/domains", async () => {
    const ids = [fixture.domainId];
    for (const i of range().slice(1)) {
      const id = newId("domain");
      ids.push(id);
      await db.insert(domains).values({ id, organizationId: fixture.organizationId, providerId: fixture.providerId, name: `d${i}.example.com` });
    }
    await share("domains", "created_at");
    expectAll(await walk(domainsGET, "/v1/domains"), ids);
  });

  it("GET /v1/emails", async () => {
    const ids = await seedMessages();
    expectAll(await walk(emailsGET, "/v1/emails"), ids);
  });

  it("GET /v1/exports", async () => {
    const ids = range().map(() => newId("export"));
    await db.insert(exportJobs).values(ids.map((id) => ({ id, organizationId: fixture.organizationId, kind: "data" as const, actorType: "api_key" as const, actorLabel: "test" })));
    await share("exports", "requested_at");
    expectAll(await walk(exportsGET, "/v1/exports"), ids);
  });

  it("GET /v1/lists and GET /v1/lists/:id/members", async () => {
    const listIds = range().map(() => newId("list"));
    await db.insert(lists).values(listIds.map((id, i) => ({ id, organizationId: fixture.organizationId, domainId: fixture.domainId, name: `List ${i}` })));
    await share("lists", "created_at");
    expectAll(await walk(listsGET, "/v1/lists"), listIds);

    const listId = listIds[0]!;
    const memberIds = range().map(() => newId("listMembership"));
    await db.insert(listMemberships).values(
      memberIds.map((id, i) => ({
        id,
        organizationId: fixture.organizationId,
        listId,
        address: `m${i}@example.net`,
        source: "import" as const,
        doubleOptIn: false,
        status: "subscribed" as const,
      })),
    );
    await share("list_memberships", "created_at");
    expectAll(await walk(membersGET, `/v1/lists/${listId}/members`, { params: Promise.resolve({ id: listId }) }), memberIds);
  });

  it("GET /v1/inbound", async () => {
    const ids = range().map(() => newId("inbound"));
    await db.insert(inboundMessages).values(
      ids.map((id) => ({
        id,
        organizationId: fixture.organizationId,
        domainId: fixture.domainId,
        fromAddress: "ada@example.net",
        to: ["reply@inbound.example.com"],
        threadId: newId("thread"),
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    );
    await share("inbound_messages", "received_at");
    expectAll(await walk(inboundGET, "/v1/inbound"), ids);
  });

  it("GET /v1/providers", async () => {
    const ids = [fixture.providerId];
    for (const i of range().slice(1)) {
      const id = newId("provider");
      ids.push(id);
      await db.insert(providers).values({
        id,
        organizationId: fixture.organizationId,
        adapter: "mock",
        name: `provider ${i}`,
        credentials: encryptCredentials({ serverToken: "t" }),
        settings: {},
        concurrency: 1,
      });
    }
    await share("providers", "created_at");
    expectAll(await walk(providersGET, "/v1/providers"), ids);
  });

  it("message log export batches", async () => {
    const ids = await seedMessages();
    const seen: string[] = [];
    for await (const row of iterateExportMessages(fixture.organizationId, {}, LIMIT)) seen.push(row.message.id);
    expectAll(seen, ids);
  });

  it("activity pages", async () => {
    const ids = range().map(() => newId("activity"));
    await db.insert(activity).values(
      ids.map((id) => ({
        id,
        organizationId: fixture.organizationId,
        action: "domain.added",
        family: "domain" as const,
        outcome: "success" as const,
        actorType: "worker" as const,
        actorLabel: "test",
      })),
    );
    await share("activity", "created_at");

    const filters = { families: [], outcomes: [], actors: [], since: null };
    const seen: string[] = [];
    let page = await listActivity(fixture.organizationId, filters, null, LIMIT);
    seen.push(...page.rows.map((row) => row.id));
    while (page.nextCursor) {
      page = await listActivity(fixture.organizationId, filters, page.nextCursor, LIMIT);
      seen.push(...page.rows.map((row) => row.id));
    }
    expectAll(seen, ids);
  });

  it("event stream replay after a cursor", async () => {
    const [messageId] = await seedMessages();
    const ids = range().map(() => newId("event"));
    await db.insert(messageEvents).values(
      ids.map((id) => ({ id, organizationId: fixture.organizationId, messageId: messageId!, kind: "transition" as const, status: "queued" as const })),
    );
    await db.execute(sql.raw(`update message_events set occurred_at = '${SHARED}' where organization_id = '${fixture.organizationId}'`));

    const caller = { organizationId: fixture.organizationId, domainIds: [] };
    const seen: string[] = [];
    let batch = await streamEventsForKey(caller, { limit: LIMIT });
    while (batch.length > 0) {
      seen.push(...batch.map((row) => row.event.id));
      const last = batch[batch.length - 1]!.event;
      batch = await streamEventsForKey(caller, { limit: LIMIT, after: { occurredAt: last.occurredAt, id: last.id } });
      if (seen.length > COUNT * 2) break;
    }
    expectAll(seen, ids);
  });
});
