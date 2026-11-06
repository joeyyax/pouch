import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { domains, inboundMessages } from "@/lib/db/schema";
import { claimRecipients } from "@/lib/addresses/route";
import { ingestInboundMessages } from "@/lib/inbound/ingest";
import { buildAdapter } from "@/lib/providers/adapters";
import { POST as createRoute } from "@/app/api/v1/addresses/route";
import { apiRequest, resetDatabase, seedFixture, type Fixture } from "./fixtures";

vi.mock("node:dns/promises", () => ({ lookup: () => Promise.resolve([{ address: "203.0.113.9", family: 4 }]) }));

const provider = buildAdapter("mailpace", { serverToken: "token" }, {});
let fixture: Fixture;

async function createAddress(): Promise<{ id: string; address: string }> {
  const res = await createRoute(apiRequest(fixture.secret, "/v1/addresses", "POST", { domain_id: fixture.domainId, expires_in: 3600 }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; address: string };
}

/** Mailpace callback through the adapter and into ingest; returns the stored row. */
async function receive(payload: Record<string, unknown>) {
  const body = JSON.stringify({ from: "ada@example.net", headers: [], messageId: "<m@example.net>", ...payload, id: Math.random() });
  const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
  const result = await ingestInboundMessages(domain!, provider.inbound!.parse!({ rawBody: body, headers: {} }));
  expect(result.accepted).toBe(1);
  const [row] = await db.select().from(inboundMessages).where(eq(inboundMessages.domainId, fixture.domainId));
  return { row: row!, claim: await claimRecipients(domain!, row!.to) };
}

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, fixture.domainId));
});

describe("Mailpace inbound routing", () => {
  it("routes a Bcc'd address to the address when Mailpace fills bcc", async () => {
    const address = await createAddress();
    const { row, claim } = await receive({ to: "list@example.org", bcc: address.address });
    expect(row.addressIds).toEqual([address.id]);
    expect(claim.unclaimed).toBe(false);
  });

  it("routes a cc'd address to the address", async () => {
    const address = await createAddress();
    const { row } = await receive({ to: "list@example.org", cc: `"Team, The" <${address.address}>` });
    expect(row.addressIds).toEqual([address.id]);
    expect(row.to).toContain(address.address);
  });

  it("routes a Bcc'd address named only by Delivered-To", async () => {
    const address = await createAddress();
    const { row } = await receive({ to: "list@example.org", headers: [`Delivered-To: ${address.address}`] });
    expect(row.addressIds).toEqual([address.id]);
  });

  it("stores a quoted Last, First recipient as one bare address", async () => {
    const address = await createAddress();
    const { row } = await receive({ to: `"Lovelace, Ada" <${address.address}>` });
    expect(row.to).toEqual([address.address]);
    expect(row.addressIds).toEqual([address.id]);
  });

  it("leaves a recipient no address claims to the domain's webhook", async () => {
    const host = (await createAddress()).address.split("@")[1];
    const { row, claim } = await receive({ to: `nobody@${host}`, cc: "other@example.org" });
    expect(row.addressIds).toEqual([]);
    expect(claim.unclaimed).toBe(true);
  });
});
