import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { memberships, users } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { addSuppression, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const sessionState = vi.hoisted(() => ({ userId: null as string | null, cookies: new Map<string, string>() }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (sessionState.cookies.has(name) ? { value: sessionState.cookies.get(name) } : undefined),
  }),
  headers: async () => new Headers(),
}));

const { GET } = await import("@/app/api/dashboard/exports/data/route");
const { ACTIVE_ORGANIZATION_COOKIE } = await import("@/lib/dashboard/session");

let home: Fixture;
let other: Fixture;

async function exportedAddresses(): Promise<string[]> {
  const response = await GET(new Request("http://localhost/api/dashboard/exports/data"));
  expect(response.status).toBe(200);
  return (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; address?: string })
    .filter((row) => row.type === "suppression")
    .map((row) => row.address!);
}

beforeEach(async () => {
  await resetDatabase();
  home = await seedFixture();
  other = await seedFixture();
  await addSuppression(home.organizationId, "home@example.com");
  await addSuppression(other.organizationId, "other@example.com");

  const userId = newId("key");
  await db.insert(users).values({ id: userId, organizationId: home.organizationId, name: "Ada", email: `${userId}@example.com` });
  sessionState.userId = userId;
  sessionState.cookies.clear();
});

describe("dashboard exports", () => {
  it("exports the organization the user switched to", async () => {
    await db.insert(memberships).values([
      { id: newId("membership"), userId: sessionState.userId!, organizationId: home.organizationId, role: "owner" },
      { id: newId("membership"), userId: sessionState.userId!, organizationId: other.organizationId, role: "member" },
    ]);
    sessionState.cookies.set(ACTIVE_ORGANIZATION_COOKIE, other.organizationId);

    expect(await exportedAddresses()).toEqual(["other@example.com"]);
  });

  it("never exports an organization the user no longer belongs to", async () => {
    await db.insert(memberships).values({ id: newId("membership"), userId: sessionState.userId!, organizationId: other.organizationId, role: "member" });

    expect(await exportedAddresses()).toEqual(["other@example.com"]);
  });

  it("refuses a signed-out caller", async () => {
    sessionState.userId = null;
    const response = await GET(new Request("http://localhost/api/dashboard/exports/data"));
    expect(response.status).toBe(401);
  });
});
