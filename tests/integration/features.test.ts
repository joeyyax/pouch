import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, domains } from "@/lib/db/schema";
import { adminActor, userActor } from "@/lib/activity/record";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { claimRecipients } from "@/lib/addresses/route";
import type { Feature } from "@/lib/features";
import { readSettings, setSetting } from "@/lib/settings/values";
import { receiveProviderMail } from "@/lib/inbound/ingest";
import { inboundHost } from "@/lib/inbound/records";
import { createList } from "@/lib/lists";
import { runObservations } from "@/lib/observations/_runner";
import { defineObservation } from "@/lib/observations/_types";
import { GET as listsGET } from "@/app/api/v1/lists/route";
import { POST as listUnsubscribePOST } from "@/app/api/v1/lists/[id]/unsubscribe/route";
import { POST as addressesPOST } from "@/app/api/v1/addresses/route";
import { POST as emailsPOST } from "@/app/api/v1/emails/route";
import { POST as mcpPOST } from "@/app/mcp/route";
import { ListConfirmLoop } from "@/worker/list-confirm";
import { apiRequest, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

const ADMIN = adminActor("usr_admin", "Admin");

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function turnOff(feature: Feature): Promise<void> {
  await setSetting(feature, false, ADMIN);
}

async function errorOf(response: Response): Promise<{ status: number; code?: string; feature?: unknown }> {
  const body = (await response.json()) as { error?: { code: string; detail?: { feature?: unknown } } };
  return { status: response.status, code: body.error?.code, feature: body.error?.detail?.feature };
}

describe("a feature's API routes", () => {
  it("answer feature_disabled while it's off, and work while it's on", async () => {
    expect((await listsGET(apiRequest(fixture.secret, "/v1/lists"))).status).toBe(200);

    await turnOff("lists");
    expect(await errorOf(await listsGET(apiRequest(fixture.secret, "/v1/lists")))).toEqual({
      status: 403,
      code: "feature_disabled",
      feature: "lists",
    });

    await setSetting("lists", true, ADMIN);
    expect((await listsGET(apiRequest(fixture.secret, "/v1/lists"))).status).toBe(200);
  });

  it("go with the feature they depend on", async () => {
    await turnOff("bulk");
    expect(await errorOf(await listsGET(apiRequest(fixture.secret, "/v1/lists")))).toMatchObject({ status: 403, feature: "lists" });
  });

  it("answer the same through the handler's own /api path", async () => {
    await turnOff("addresses");
    const response = await addressesPOST(apiRequest(fixture.secret, "/api/v1/addresses", "POST", { domain_id: fixture.domainId, expires_in: 3600 }));
    expect(await errorOf(response)).toMatchObject({ status: 403, feature: "addresses" });
  });

  it("leave unsubscribing open with lists off", async () => {
    const list = await createList(
      { organizationId: fixture.organizationId, domainIds: [], actor: userActor("u1", "Test") },
      { domain_id: fixture.domainId, name: "News" },
    );
    await turnOff("lists");
    const response = await listUnsubscribePOST(
      apiRequest(fixture.secret, `/v1/lists/${list.id}/unsubscribe`, "POST", { address: "ada@example.com" }),
      routeContext(list.id),
    );
    expect(response.status).toBe(200);
  });

  it("refuse subscribe on a send while lists are off", async () => {
    await turnOff("lists");
    const response = await emailsPOST(
      apiRequest(fixture.secret, "/v1/emails", "POST", {
        from: "hi@example.com",
        to: "ada@example.com",
        subject: "Hi",
        text: "Hi",
        subscribe: ["lst_unknown"],
      }),
    );
    expect(await errorOf(response)).toMatchObject({ status: 403, code: "feature_disabled", feature: "lists" });
  });

  it("let the environment win over the setting", async () => {
    await turnOff("lists");
    vi.stubEnv("FEATURE_LISTS", "true");
    expect((await listsGET(apiRequest(fixture.secret, "/v1/lists"))).status).toBe(200);
    await expect(setSetting("lists", false, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("MCP", () => {
  function call(body: unknown): Promise<Response> {
    return mcpPOST(
      new Request("http://mcp.test/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${fixture.secret}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("refuses the endpoint while it's off", async () => {
    expect((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(200);
    await turnOff("mcp");
    expect(await errorOf(await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }))).toMatchObject({ status: 403, feature: "mcp" });
  });

  it("returns feature_disabled from a tool whose feature is off", async () => {
    await turnOff("lists");
    const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_lists", arguments: {} } });
    const result = ((await response.json()) as { result: { isError: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toMatchObject({ code: "feature_disabled", detail: { feature: "lists" } });
  });
});

describe("turning a feature on or off", () => {
  it("is recorded on the service once per change", async () => {
    await turnOff("inbound");
    await turnOff("inbound");
    await setSetting("inbound", true, ADMIN);

    const rows = await db.select().from(activity).where(eq(activity.appliesTo, "inbound"));
    expect(rows.map((row) => [row.action, row.organizationId])).toEqual([
      ["system.feature.turned_off", null],
      ["system.feature.turned_on", null],
    ]);
  });

  it("reads back with where the value came from", async () => {
    await turnOff("bulk");
    const byKey = new Map((await readSettings()).map((state) => [state.key, state]));
    expect(byKey.get("bulk")).toMatchObject({ value: false, available: true, source: "settings" });
    expect(byKey.get("lists")).toMatchObject({ value: true, available: false, source: "default" });
  });

  it("refuses a value outside the entry's type", async () => {
    await expect(setSetting("bulk", "sometimes", ADMIN)).rejects.toMatchObject({ code: "validation_failed", field: "bulk" });
  });
});

describe("the worker", () => {
  it("skips a loop's pass while its feature is off", async () => {
    const loop = new ListConfirmLoop({ workerId: "test", intervalMs: 60_000, batchSize: 10 });
    expect(await loop.pass()).toBe(0);
    await turnOff("lists");
    expect(await loop.pass()).toBeUndefined();
  });
});

describe("inbound", () => {
  function received() {
    return {
      domainId: "dom_missing",
      providerMessageId: "m-1",
      recipients: [],
      verdicts: null,
      read: vi.fn(async () => null),
      discard: vi.fn(async () => {}),
    };
  }

  it("leaves the provider's copy unread and in place while it's off", async () => {
    const on = received();
    await receiveProviderMail(fixture.providerId, on);
    expect(on.discard).toHaveBeenCalledOnce();

    await turnOff("inbound");
    const off = received();
    expect(await receiveProviderMail(fixture.providerId, off)).toEqual({ accepted: 1, duplicates: 0 });
    expect(off.read).not.toHaveBeenCalled();
    expect(off.discard).not.toHaveBeenCalled();
  });

  it("gives an address no mail while addresses are off", async () => {
    await db.update(domains).set({ inboundEnabled: true }).where(eq(domains.id, fixture.domainId));
    const created = await addressesPOST(
      apiRequest(fixture.secret, "/v1/addresses", "POST", { domain_id: fixture.domainId, local_part: "agent", expires_in: 3600 }),
    );
    expect(created.status).toBe(201);
    const [domain] = await db.select().from(domains).where(eq(domains.id, fixture.domainId));
    const to = [`agent@${inboundHost(domain!.name, domain!.inboundSubdomain)}`];

    expect((await claimRecipients(domain!, to)).addresses).toHaveLength(1);
    await turnOff("addresses");
    expect(await claimRecipients(domain!, to)).toEqual({ unclaimed: false, addresses: [] });
  });
});

describe("observations", () => {
  const always = defineObservation({
    key: "always",
    title: "Always",
    description: "Always finds one.",
    tone: "warning",
    mutableBy: [],
    example: { tags: [], keyIds: [] },
    evaluate: async () => [{ tags: [], keyIds: [] }],
    condition: () => ({ title: "Always", body: "", links: [] }),
    digestLine: () => ({ text: "Always", path: "/" }),
  });

  it("run nothing while the feature is off", async () => {
    expect(await runObservations(fixture.organizationId, new Date(), [always])).toHaveLength(1);
    await turnOff("observations");
    expect(await runObservations(fixture.organizationId, new Date(), [always])).toEqual([]);
  });
});
