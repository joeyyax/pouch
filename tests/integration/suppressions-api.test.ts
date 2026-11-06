import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, suppressions } from "@/lib/db/schema";
import { GET, POST } from "@/app/api/v1/suppressions/route";
import { DELETE, GET as GET_ONE } from "@/app/api/v1/suppressions/[address]/route";
import { applyEvent } from "@/lib/messages/events";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { PouchClient } from "@/sdk/pouch";
import { addDomainKey, addSuppression, eventSource, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

interface ImportBody {
  added: number;
  already_present: number;
  invalid: number;
  errors: { line: number | null; address: string; message: string }[];
}

interface Suppression {
  id: string;
  address: string;
  reason: string;
  detail: string | null;
  bounce_type: string | null;
  source: string | null;
  source_message_id: string | null;
  created_at: string;
}

interface Page {
  data: Suppression[];
  next_cursor: string | null;
}

function postJson(secret: string, body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/v1/suppressions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    }),
  );
}

function postCsv(secret: string, csv: string, query = ""): Promise<Response> {
  return POST(
    new Request(`http://localhost/v1/suppressions${query}`, {
      method: "POST",
      headers: { "content-type": "text/csv; charset=utf-8", authorization: `Bearer ${secret}` },
      body: csv,
    }),
  );
}

function remove(secret: string, address: string): Promise<Response> {
  return DELETE(
    new Request(`http://localhost/v1/suppressions/${encodeURIComponent(address)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    }),
    { params: Promise.resolve({ address }) },
  );
}

function list(secret: string, query = ""): Promise<Response> {
  return GET(new Request(`http://localhost/v1/suppressions${query}`, { headers: { authorization: `Bearer ${secret}` } }));
}

function readOne(secret: string, idOrAddress: string): Promise<Response> {
  return GET_ONE(
    new Request(`http://localhost/v1/suppressions/${encodeURIComponent(idOrAddress)}`, {
      headers: { authorization: `Bearer ${secret}` },
    }),
    { params: Promise.resolve({ address: idOrAddress }) },
  );
}

/** A hard bounce on a real message, applied the way a provider callback applies it. */
async function bounce(on: Fixture, address: string): Promise<string> {
  const messageId = await seedMessage(on, { to: address, status: "sent", providerId: on.providerId, providerMessageId: `pm-${address}` });
  await applyEvent(eventSource(on), {
    providerMessageId: `pm-${address}`,
    providerEventId: `ev-${address}`,
    status: "bounced",
    reason: "smtp; 550 5.1.1 user unknown",
    bounceType: "Permanent/NoEmail",
    occurredAt: new Date(),
    detail: {},
    recipients: [address],
  });
  return messageId;
}

async function rowsFor(organizationId: string) {
  return db.select().from(suppressions).where(eq(suppressions.organizationId, organizationId));
}

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});

describe("POST /v1/suppressions", () => {
  it("adds valid rows, reports invalid ones and normalizes the domain part only", async () => {
    const response = await postJson(fixture.secret, {
      reason: "hard_bounce",
      source: "postmark",
      suppressions: [
        { address: "Ada@Example.COM", detail: "550 no such user" },
        { address: "not-an-address" },
        { address: "grace@example.net", reason: "complaint" },
      ],
    });
    const body = (await response.json()) as ImportBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      added: 2,
      already_present: 0,
      invalid: 1,
      errors: [{ line: null, address: "not-an-address", message: '"not-an-address" isn\'t a valid address.' }],
    });

    const rows = await rowsFor(fixture.organizationId);
    expect(rows.map((r) => [r.address, r.reason, r.detail, r.source]).sort()).toEqual([
      ["Ada@example.com", "hard_bounce", "550 no such user", "postmark"],
      ["grace@example.net", "complaint", null, "postmark"],
    ]);
  });

  it("leaves an existing suppression as it was and counts repeats as already present", async () => {
    await addSuppression(fixture.organizationId, "ada@example.com");
    const [before] = await rowsFor(fixture.organizationId);

    const response = await postJson(fixture.secret, {
      suppressions: [{ address: "ada@EXAMPLE.com", detail: "imported" }, { address: "bob@example.com" }, { address: "bob@Example.com" }],
    });
    const body = (await response.json()) as ImportBody;

    expect(body).toMatchObject({ added: 1, already_present: 2, invalid: 0 });
    const rows = await rowsFor(fixture.organizationId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.address === "ada@example.com")).toEqual(before);
    expect(rows.find((r) => r.address === "bob@example.com")).toMatchObject({ reason: "manual", source: "api" });
  });

  it("records one activity row for an import that added something, and none for one that didn't", async () => {
    await postJson(fixture.secret, { source: "sendgrid", suppressions: [{ address: "ada@example.com" }, { address: "bob@example.com" }] });
    await postJson(fixture.secret, { suppressions: [{ address: "ada@example.com" }] });

    const rows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.organizationId, fixture.organizationId), eq(activity.family, "suppression")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "suppression.imported",
      actorType: "api_key",
      metadata: { added: 2, already_present: 0, invalid: 0, source: "sendgrid" },
    });
  });

  it("takes 5000 rows and refuses 5001 without writing any", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ address: `user${i}@example.com` }));

    const refused = await postJson(fixture.secret, { suppressions: rows(5001) });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { code: string; field: string } }).error).toMatchObject({
      code: "validation_failed",
      field: "suppressions",
    });
    expect(await rowsFor(fixture.organizationId)).toHaveLength(0);

    const accepted = await postJson(fixture.secret, { suppressions: rows(5000) });
    expect(((await accepted.json()) as ImportBody).added).toBe(5000);
  });

  it("refuses an unknown reason and an empty list", async () => {
    const badReason = await postJson(fixture.secret, { reason: "unsubscribed", suppressions: [{ address: "ada@example.com" }] });
    expect(badReason.status).toBe(422);
    expect(((await badReason.json()) as { error: { field: string } }).error.field).toBe("reason");

    const empty = await postJson(fixture.secret, { suppressions: [] });
    expect(empty.status).toBe(422);
  });

  it("imports a CSV with another provider's column names and reason words", async () => {
    const csv = [
      "EmailAddress,SuppressionReason,CreatedAt",
      "ada@example.com,HardBounce,2026-01-01",
      "bob@example.com,SpamComplaint,2026-01-02",
      ",HardBounce,2026-01-03",
      "cy@example.com,550 5.1.1 mailbox unavailable,2026-01-04",
      "",
    ].join("\r\n");
    const response = await postCsv(fixture.secret, csv, "?reason=manual&source=postmark");
    const body = (await response.json()) as ImportBody;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      added: 3,
      already_present: 0,
      invalid: 1,
      errors: [{ line: 4, address: "", message: "Address is required." }],
    });
    const rows = await rowsFor(fixture.organizationId);
    expect(rows.map((r) => [r.address, r.reason, r.detail, r.source]).sort()).toEqual([
      ["ada@example.com", "hard_bounce", null, "postmark"],
      ["bob@example.com", "complaint", null, "postmark"],
      ["cy@example.com", "manual", "550 5.1.1 mailbox unavailable", "postmark"],
    ]);
  });

  it("refuses a CSV with no address column, or more rows than one call takes", async () => {
    const noAddress = await postCsv(fixture.secret, "name,reason\nAda,bounce\n");
    expect(noAddress.status).toBe(422);

    const tooMany = ["address", ...Array.from({ length: 5001 }, (_, i) => `user${i}@example.com`)].join("\n");
    const refused = await postCsv(fixture.secret, tooMany);
    expect(refused.status).toBe(422);
    expect(await rowsFor(fixture.organizationId)).toHaveLength(0);
  });

  it("writes only to the key's own organization", async () => {
    const other = await seedFixture({ scopeToDomain: false });
    await addSuppression(other.organizationId, "ada@example.com");

    const body = (await (await postJson(fixture.secret, { suppressions: [{ address: "ada@example.com" }] })).json()) as ImportBody;

    expect(body.added).toBe(1);
    const theirs = await rowsFor(other.organizationId);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ reason: "hard_bounce", source: null });
    expect(await rowsFor(fixture.organizationId)).toHaveLength(1);
  });
});

describe("GET /v1/suppressions", () => {
  it("pages through one import's rows without skipping or repeating any", async () => {
    const addresses = Array.from({ length: 120 }, (_, i) => `user${i}@example.com`);
    await postJson(fixture.secret, { suppressions: addresses.map((address) => ({ address })) });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await list(fixture.secret, `?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as Page;
      seen.push(...page.data.map((s) => s.address));
      cursor = page.next_cursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen)).toEqual(new Set(addresses));
  });

  it("filters by reason and by address, matched on the normalized form", async () => {
    await postJson(fixture.secret, {
      suppressions: [
        { address: "ada@example.com", reason: "hard_bounce" },
        { address: "bob@example.com", reason: "complaint" },
      ],
    });

    const byReason = (await (await list(fixture.secret, "?reason=complaint")).json()) as Page;
    expect(byReason.data.map((s) => s.address)).toEqual(["bob@example.com"]);
    expect(byReason.next_cursor).toBeNull();

    const byAddress = (await (await list(fixture.secret, "?address=ada%40EXAMPLE.com")).json()) as Page;
    expect(byAddress.data).toEqual([
      expect.objectContaining({ address: "ada@example.com", reason: "hard_bounce", source: "api", source_message_id: null }),
    ]);

    const badReason = await list(fixture.secret, "?reason=bounce");
    expect(badReason.status).toBe(422);
  });

  it("never returns another organization's suppressions, even given its cursor", async () => {
    const other = await seedFixture({ scopeToDomain: false });
    await addSuppression(other.organizationId, "theirs@example.com");
    const [theirs] = await rowsFor(other.organizationId);
    await addSuppression(fixture.organizationId, "ours@example.com");

    const page = (await (await list(fixture.secret)).json()) as Page;
    expect(page.data.map((s) => s.address)).toEqual(["ours@example.com"]);

    const withTheirCursor = (await (await list(fixture.secret, `?cursor=${theirs!.id}`)).json()) as Page;
    expect(withTheirCursor.data.map((s) => s.address)).toEqual(["ours@example.com"]);

    const theirPage = (await (await list(other.secret)).json()) as Page;
    expect(theirPage.data.map((s) => s.address)).toEqual(["theirs@example.com"]);
  });
});

describe("DELETE /v1/suppressions/:address", () => {
  it("removes the address and records the activity row", async () => {
    await postJson(fixture.secret, { suppressions: [{ address: "ada@example.com" }, { address: "bob@example.com" }] });

    const response = await remove(fixture.secret, "ada@example.com");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ address: "ada@example.com", removed: true });
    expect((await rowsFor(fixture.organizationId)).map((row) => row.address)).toEqual(["bob@example.com"]);

    const rows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.organizationId, fixture.organizationId), eq(activity.action, "suppression.removed")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "suppression.removed", actorType: "api_key" });
  });

  it("matches on the normalized form", async () => {
    await addSuppression(fixture.organizationId, "ada@example.com");

    const response = await remove(fixture.secret, "ada@EXAMPLE.com");

    expect(response.status).toBe(200);
    expect(await rowsFor(fixture.organizationId)).toHaveLength(0);
  });

  it("answers 404 for an address that isn't on the list", async () => {
    const response = await remove(fixture.secret, "nobody@example.com");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("leaves another organization's row alone", async () => {
    const other = await seedFixture({ scopeToDomain: false });
    await addSuppression(other.organizationId, "ada@example.com");

    const response = await remove(fixture.secret, "ada@example.com");

    expect(response.status).toBe(404);
    expect(await rowsFor(other.organizationId)).toHaveLength(1);
  });
});

describe("SDK suppressions", () => {
  it("imports, lists and removes through the real route", async () => {
    const routeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "POST") return POST(request);
      if (request.method === "DELETE") {
        const address = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
        return DELETE(request, { params: Promise.resolve({ address }) });
      }
      return GET(request);
    }) as typeof fetch;
    const pouch = new PouchClient({ apiKey: fixture.secret, baseUrl: "http://localhost", fetch: routeFetch });

    const result = await pouch.suppressions.import({
      source: "resend",
      reason: "hard_bounce",
      suppressions: [{ address: "ada@example.com" }, { address: "bob@example.com", reason: "complaint" }],
    });
    expect(result).toEqual({ added: 2, already_present: 0, invalid: 0, errors: [] });

    const page = await pouch.suppressions.list({ reason: "complaint" });
    expect(page.data).toEqual([expect.objectContaining({ address: "bob@example.com", source: "resend" })]);
    expect(page.next_cursor).toBeNull();

    expect(await pouch.suppressions.remove("bob@example.com")).toEqual({ address: "bob@example.com", removed: true });
    expect((await pouch.suppressions.list()).data.map((s) => s.address)).toEqual(["ada@example.com"]);
  });
});

describe("GET /v1/suppressions/:address", () => {
  it("reads a bounce by id and by address, with the message and the provider's words", async () => {
    const messageId = await bounce(fixture, "Ada@example.net");
    const [row] = await rowsFor(fixture.organizationId);

    for (const segment of [row!.id, "Ada@EXAMPLE.net"]) {
      const response = await readOne(fixture.secret, segment);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: row!.id,
        address: "Ada@example.net",
        reason: "hard_bounce",
        detail: "smtp; 550 5.1.1 user unknown",
        bounce_type: "Permanent/NoEmail",
        source_message_id: messageId,
      });
    }
  });

  it("answers 404 for another organization's id or address", async () => {
    const other = await seedFixture({ scopeToDomain: false });
    await addSuppression(other.organizationId, "ada@example.com");
    const [theirs] = await rowsFor(other.organizationId);

    expect((await readOne(fixture.secret, theirs!.id)).status).toBe(404);
    expect((await readOne(fixture.secret, "ada@example.com")).status).toBe(404);
    expect((await readOne(other.secret, theirs!.id)).status).toBe(200);
  });
});

describe("GET /v1/suppressions filters", () => {
  it("narrows to the domain that sent the message behind it", async () => {
    const second = await addDomainKey(fixture);
    await bounce(fixture, "ada@example.net");
    await bounce({ ...fixture, domainId: second.domainId }, "bob@example.net");
    await addSuppression(fixture.organizationId, "cy@example.net");

    const page = (await (await list(fixture.secret, `?domain=${second.domainId}`)).json()) as Page;
    expect(page.data.map((s) => s.address)).toEqual(["bob@example.net"]);
  });

  it("narrows to when it was added", async () => {
    await addSuppression(fixture.organizationId, "old@example.com");
    await db.update(suppressions).set({ createdAt: new Date("2026-01-10T12:00:00Z") }).where(eq(suppressions.address, "old@example.com"));
    await addSuppression(fixture.organizationId, "new@example.com");

    const since = (await (await list(fixture.secret, "?since=2026-02-01T00:00:00Z")).json()) as Page;
    expect(since.data.map((s) => s.address)).toEqual(["new@example.com"]);
    const until = (await (await list(fixture.secret, "?until=2026-01-31T00:00:00Z")).json()) as Page;
    expect(until.data.map((s) => s.address)).toEqual(["old@example.com"]);
  });
});

describe("a key scoped to a domain", () => {
  it.each([
    ["POST /v1/suppressions", (secret: string) => postJson(secret, { suppressions: [{ address: "new@example.com" }] })],
    ["GET /v1/suppressions", (secret: string) => list(secret)],
    ["DELETE /v1/suppressions/:address", (secret: string) => remove(secret, "ada@example.com")],
    ["GET /v1/suppressions/:address", (secret: string) => readOne(secret, "ada@example.com")],
  ])("is refused by %s, and nothing changes", async (_route, call) => {
    await addSuppression(fixture.organizationId, "ada@example.com");
    const scoped = await addDomainKey(fixture, "second.example.com");

    const response = await call(scoped.secret);

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("key_not_scoped");
    expect((await rowsFor(fixture.organizationId)).map((row) => row.address)).toEqual(["ada@example.com"]);
  });
});
