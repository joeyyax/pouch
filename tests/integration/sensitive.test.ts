import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messageEvents } from "@/lib/db/schema";
import { POST as emailsPOST, GET as emailsGET } from "@/app/api/v1/emails/route";
import { GET as emailGET } from "@/app/api/v1/emails/[id]/route";
import { POST as resendPOST } from "@/app/api/v1/emails/[id]/resend/route";
import { POST as mcpPOST } from "@/app/mcp/route";
import { listMessages as listDashboardMessages, readMessage, readMessageBody } from "@/lib/dashboard/messages";
import { loadExportBody } from "@/lib/exports/eml";
import { openMessageDownload, signMessageDownload } from "@/lib/messages/downloads";
import { claimMessages, dueProviders } from "@/lib/messages/queue";
import { readMessagesQuery } from "@/lib/messages/query";
import { mockSends, resetMockSends } from "@/lib/providers/adapters/mock";
import { deliver } from "@/worker/send";
import { RetentionLoop } from "@/worker/retention";
import { apiRequest, messageRow, resetDatabase, routeContext, seedFixture, seedMessage, type Fixture } from "./fixtures";

const SEND = {
  from: "Ada <ada@example.com>",
  to: ["person@example.net"],
  subject: "Your sign-in code",
  text: "Your code is SECRET123456",
  attachments: [{ filename: "code.txt", content: Buffer.from("SECRET123456").toString("base64"), content_type: "text/plain" }],
};

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetMockSends();
  fixture = await seedFixture({ scopeToDomain: false });
});

async function send(body: Record<string, unknown>): Promise<Response> {
  return emailsPOST(apiRequest(fixture.secret, "/v1/emails", "POST", body));
}

async function sendSensitive(): Promise<string> {
  const response = await send({ ...SEND, sensitive: true });
  expect(response.status).toBe(202);
  return ((await response.json()) as { id: string }).id;
}

async function deliverAll(): Promise<void> {
  for (const provider of await dueProviders()) {
    for (const item of await claimMessages({ workerId: "worker-test", providerId: provider.id, limit: 10 })) await deliver(item);
  }
}

const sweep = () => new RetentionLoop({ intervalMs: 60_000, batchSize: 100 }).tick();

async function mcpReadEmail(id: string): Promise<string> {
  const response = await mcpPOST(
    new Request("http://mcp.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${fixture.secret}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_email", arguments: { id, include: ["body", "rendered"] } } }),
    }),
  );
  const result = ((await response.json()) as { result: { content: { text: string }[] } }).result;
  return result.content[0]!.text;
}

const WITHHELD = { reason: "withheld", message: "Body withheld: it was marked as sensitive.", ended_at: null };

describe("POST /v1/emails with sensitive", () => {
  it("answers sensitive: true and stores an empty reason", async () => {
    const response = await send({ ...SEND, sensitive: true });
    expect(response.status).toBe(202);
    const message = (await response.json()) as { id: string; sensitive: boolean };
    expect(message.sensitive).toBe(true);
    expect((await messageRow(message.id)).bodyWithheld).toBe("");
  });

  it("answers sensitive: false without it", async () => {
    const response = await send(SEND);
    const message = (await response.json()) as { id: string; sensitive: boolean };
    expect(message.sensitive).toBe(false);
    expect((await messageRow(message.id)).bodyWithheld).toBeNull();
  });

  it("refuses the SMTP header on the API and names the field", async () => {
    const response = await send({ ...SEND, headers: { "X-Pouch-Sensitive": "1" } });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: unknown }).error).toMatchObject({
      code: "reserved_header",
      message: 'Header "X-Pouch-Sensitive" is read over SMTP only. Set "sensitive": true instead.',
    });
  });

  it("still sends the real body", async () => {
    await sendSensitive();
    await deliverAll();
    expect(mockSends()[0]!.message.text).toContain("SECRET123456");
  });

  it("refuses the body on every read path, before and after the sweep", async () => {
    const id = await sendSensitive();

    const check = async () => {
      const read = await emailGET(apiRequest(fixture.secret, `/v1/emails/${id}?include=body,rendered`), routeContext(id));
      const readText = await read.text();
      expect(readText).not.toContain("SECRET123456");
      expect(JSON.parse(readText)).toMatchObject({ sensitive: true, body: null, rendered: null, body_unavailable: WITHHELD });

      const list = await emailsGET(apiRequest(fixture.secret, "/v1/emails?include=body"));
      const listText = await list.text();
      expect(listText).not.toContain("SECRET123456");
      expect((JSON.parse(listText) as { data: unknown[] }).data[0]).toMatchObject({ id, body: null, body_unavailable: WITHHELD });

      const tool = await mcpReadEmail(id);
      expect(tool).not.toContain("SECRET123456");
      expect(JSON.parse(tool)).toMatchObject({ body: null, body_unavailable: WITHHELD });

      const row = await messageRow(id);
      expect((await loadExportBody(row, 45)).status).toBe("withheld");
      expect(await openMessageDownload(signMessageDownload(id, 0, new Date(Date.now() + 60_000)))).toBeNull();
      expect((await readMessageBody(fixture.organizationId, id))?.body).toEqual({ state: "withheld", reason: "" });
    };

    await check();
    await deliverAll();
    await sweep();

    const row = await messageRow(id);
    expect(row.status).toBe("sent");
    expect(row.bodyKey).toBeNull();
    expect(row.bodyPurgedAt).not.toBeNull();
    const events = await db.select().from(messageEvents).where(eq(messageEvents.messageId, id));
    expect(events.map((event) => event.status ?? event.kind)).toContain("body_shredded");
    await check();
  });

  it("leaves an ordinary message's attachment downloadable", async () => {
    const response = await send(SEND);
    const { id } = (await response.json()) as { id: string };
    const opened = await openMessageDownload(signMessageDownload(id, 0, new Date(Date.now() + 60_000)));
    expect(opened?.content.toString()).toBe("SECRET123456");
  });

  it("refuses a resend with the short sentence", async () => {
    const id = await sendSensitive();
    const response = await resendPOST(apiRequest(fixture.secret, `/v1/emails/${id}/resend`, "POST"), routeContext(id));
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: unknown }).error).toMatchObject({
      code: "resend_not_allowed",
      message: "This message can't be resent. It was marked as sensitive.",
      detail: { reason: "withheld" },
    });
  });
});

describe("the sensitive filter", () => {
  async function seedPair(): Promise<{ sensitive: string; plain: string }> {
    const sensitive = await seedMessage(fixture, { bodyWithheld: "", subject: "Code" });
    const plain = await seedMessage(fixture, { subject: "Receipt" });
    return { sensitive, plain };
  }

  async function listIds(query: string): Promise<string[]> {
    const response = await emailsGET(apiRequest(fixture.secret, `/v1/emails?${query}`));
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: { id: string }[] }).data.map((message) => message.id);
  }

  it("narrows GET /v1/emails either way", async () => {
    const { sensitive, plain } = await seedPair();
    expect(await listIds("sensitive=true")).toEqual([sensitive]);
    expect(await listIds("sensitive=false")).toEqual([plain]);
    expect((await listIds("")).sort()).toEqual([sensitive, plain].sort());
  });

  it("counts credential mail as sensitive", async () => {
    const credential = await seedMessage(fixture, { bodyWithheld: "a sign-in link" });
    expect(await listIds("sensitive=true")).toEqual([credential]);
  });

  it("refuses a value that isn't true or false", async () => {
    const response = await emailsGET(apiRequest(fixture.secret, "/v1/emails?sensitive=yes"));
    expect(response.status).toBe(422);
  });

  it("narrows the dashboard list from ?sensitive=1, and marks the row", async () => {
    const { sensitive } = await seedPair();
    const query = readMessagesQuery({ sensitive: "1" });
    expect(query.sensitive).toBe(true);
    expect(query.narrowed).toBe(true);

    const rows = await listDashboardMessages(fixture.organizationId, query.filters);
    expect(rows.map((row) => [row.id, row.sensitive])).toEqual([[sensitive, true]]);

    const all = await listDashboardMessages(fixture.organizationId, readMessagesQuery({}).filters);
    expect(all.map((row) => row.sensitive).sort()).toEqual([false, true]);
  });
});

describe("the sensitive fun fact", () => {
  const HOUR = 3_600_000;
  const now = Date.now();

  async function seedTo(address: string, agoMs: number, reason: string, extra: { testMode?: boolean; to?: string[] } = {}): Promise<string> {
    return seedMessage(fixture, {
      to: extra.to ?? [address],
      bodyWithheld: reason,
      testMode: extra.testMode ?? false,
      createdAt: new Date(now - agoMs),
    });
  }

  async function factTexts(id: string): Promise<string[]> {
    return ((await readMessage(fixture.organizationId, id))?.facts ?? []).map((fact) => fact.text);
  }

  it("counts the same reason to the same address this week, up to the message", async () => {
    await seedTo("ada@example.net", 6 * 24 * HOUR, "a sign-in link");
    await seedTo("ada@example.net", 3 * 24 * HOUR, "a sign-in link");
    // Older than a week, another reason, another address, test mode and a later message don't count.
    await seedTo("ada@example.net", 8 * 24 * HOUR, "a sign-in link");
    await seedTo("ada@example.net", 2 * 24 * HOUR, "a password reset link");
    await seedTo("bob@example.net", 2 * 24 * HOUR, "a sign-in link");
    await seedTo("ada@example.net", 2 * 24 * HOUR, "a sign-in link", { testMode: true });
    const id = await seedTo("ada@example.net", HOUR, "a sign-in link");
    await seedTo("ada@example.net", HOUR / 2, "a sign-in link");

    expect(await factTexts(id)).toContain("The third sign-in link to this address this week.");
  });

  it("counts every sensitive message for an empty reason", async () => {
    for (const days of [5, 4, 3, 2]) await seedTo("ada@example.net", days * 24 * HOUR, days % 2 ? "" : "a sign-in link");
    const id = await seedTo("ada@example.net", HOUR, "");
    expect(await factTexts(id)).toContain("The fifth sensitive message to this address this week.");
  });

  it("says someone may be targeting the account from 10 in 24 hours", async () => {
    for (let i = 9; i >= 1; i -= 1) await seedTo("ada@example.net", i * HOUR, "a sign-in link");
    const id = await seedTo("ada@example.net", 0, "a sign-in link");
    const facts = (await readMessage(fixture.organizationId, id))?.facts ?? [];
    expect(facts[0]).toMatchObject({
      tone: "warn",
      text: "The tenth sign-in link to this address in 24 hours. Someone may be targeting this account.",
    });
  });

  it("says nothing for a message to several recipients", async () => {
    await seedTo("ada@example.net", 3 * HOUR, "");
    await seedTo("ada@example.net", 2 * HOUR, "");
    const id = await seedTo("ada@example.net", HOUR, "", { to: ["ada@example.net", "bob@example.net"] });
    expect((await factTexts(id)).some((text) => text.includes("this address"))).toBe(false);
  });
});
