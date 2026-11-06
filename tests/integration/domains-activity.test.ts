import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// Toggled by the one test that needs the activity insert itself to fail. An adapter mock, not
// `vi.spyOn(db, ...)`: `db` is a lazy-connect proxy whose getter always resolves back to the
// live connection, so a spy attached to the proxy object is never consulted.
const failActivityInsert = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { activity: activityTable } = await import("@/lib/db/schema");
  const realInsert = actual.db.insert.bind(actual.db);
  const wrapped = new Proxy(actual.db, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return (table: unknown) => {
          if (failActivityInsert.value && table === activityTable) {
            return { values: () => Promise.reject(new Error("simulated activity insert failure")) };
          }
          return realInsert(table as never);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ...actual, db: wrapped };
});

import { db } from "@/lib/db";
import { activity, domains } from "@/lib/db/schema";
import { GET as list, POST as create } from "@/app/api/v1/domains/route";
import { DELETE as remove, GET as read, PATCH as patch } from "@/app/api/v1/domains/[id]/route";
import { POST as verify } from "@/app/api/v1/domains/[id]/verify/route";
import { addProvider, apiRequest, resetDatabase, routeContext, seedFixture, type Fixture } from "./fixtures";

interface SerializedDomain {
  id: string;
  name: string;
  status: string;
}

const request = (secret: string, path: string, method = "GET", body?: unknown): Request =>
  apiRequest(secret, `/v1/domains${path}`, method, body);

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => vi.unstubAllGlobals());

async function activityFor(id: string): Promise<{ action: string; actorType: string; actorId: string | null }[]> {
  const rows = await db.select().from(activity).where(eq(activity.appliesTo, id));
  return rows.map((row) => ({ action: row.action, actorType: row.actorType, actorId: row.actorId }));
}

describe("activity coverage for /v1/domains", () => {
  it("records domain.added with the key as actor", async () => {
    const body = (await (
      await create(request(fixture.secret, "", "POST", { name: "example.net", provider_id: fixture.providerId }))
    ).json()) as SerializedDomain;

    const rows = await activityFor(body.id);
    expect(rows).toEqual([{ action: "domain.added", actorType: "api_key", actorId: fixture.key.id }]);
  });

  it("records domain.deleted with the key as actor", async () => {
    const created = (await (
      await create(request(fixture.secret, "", "POST", { name: "example.net", provider_id: fixture.providerId }))
    ).json()) as SerializedDomain;

    await remove(request(fixture.secret, `/${created.id}`, "DELETE"), routeContext(created.id));

    const rows = await activityFor(created.id);
    expect(rows.map((row) => row.action)).toContain("domain.deleted");
    expect(rows.find((row) => row.action === "domain.deleted")).toMatchObject({ actorType: "api_key", actorId: fixture.key.id });
  });

  it("records domain.move.started, then domain.move.cancelled, with the key as actor", async () => {
    const target = await addProvider(fixture, { providerAdapter: "mock", name: "secondary" });

    await patch(
      request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: target.providerId }),
      routeContext(fixture.domainId),
    );
    await patch(request(fixture.secret, `/${fixture.domainId}`, "PATCH", { provider_id: null }), routeContext(fixture.domainId));

    const rows = await activityFor(fixture.domainId);
    expect(rows).toEqual([
      { action: "domain.move.started", actorType: "api_key", actorId: fixture.key.id },
      { action: "domain.move.cancelled", actorType: "api_key", actorId: fixture.key.id },
    ]);
  });

  it("records domain.verified with the key as actor, only on the transition", async () => {
    const created = (await (
      await create(request(fixture.secret, "", "POST", { name: "example.net", provider_id: fixture.providerId }))
    ).json()) as SerializedDomain;

    await verify(request(fixture.secret, `/${created.id}/verify`, "POST"), routeContext(created.id));
    await verify(request(fixture.secret, `/${created.id}/verify`, "POST"), routeContext(created.id));

    const rows = await activityFor(created.id);
    expect(rows.filter((row) => row.action === "domain.verified")).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "api_key", actorId: fixture.key.id });
  });

  it("records nothing for a plain read — GET is not provider configuration changing", async () => {
    await read(request(fixture.secret, `/${fixture.domainId}`), routeContext(fixture.domainId));
    await list(request(fixture.secret, ""));

    expect(await activityFor(fixture.domainId)).toEqual([]);
  });

  it("still creates the domain when the activity write fails", async () => {
    failActivityInsert.value = true;
    try {
      const response = await create(
        request(fixture.secret, "", "POST", { name: "example.net", provider_id: fixture.providerId }),
      );
      const body = (await response.json()) as SerializedDomain;

      expect(response.status).toBe(201);
      expect(body.name).toBe("example.net");

      const [row] = await db.select().from(domains).where(eq(domains.id, body.id)).limit(1);
      expect(row).toBeDefined();
      expect(await activityFor(body.id)).toEqual([]);
    } finally {
      failActivityInsert.value = false;
    }
  });
});
