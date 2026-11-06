import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { lists, listMemberships } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { MAX_CONFIRMATION_ATTEMPTS, pendingConfirmations, sendConfirmation } from "@/lib/lists/opt-in";
import { resetDatabase, seedFixture, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ domainStatus: "verified" });
});

async function seedList(): Promise<string> {
  const id = newId("list");
  await db.insert(lists).values({
    id,
    organizationId: fixture.organizationId,
    domainId: fixture.domainId,
    name: "Product updates",
    doubleOptIn: true,
  });
  return id;
}

async function seedPendingMember(listId: string, address: string, attempts = 0): Promise<string> {
  const id = newId("listMembership");
  await db.insert(listMemberships).values({
    id,
    organizationId: fixture.organizationId,
    listId,
    address,
    status: "pending",
    source: "manual",
    doubleOptIn: true,
    confirmationAttempts: attempts,
  });
  return id;
}

describe("pending confirmations", () => {
  it("stops offering a membership once it has used every attempt", async () => {
    // Without the ceiling, an address the provider will never accept is handed to the worker
    // every ten seconds for the life of the row, taking a place in every batch.
    const listId = await seedList();
    const exhausted = await seedPendingMember(listId, "never@example.com", MAX_CONFIRMATION_ATTEMPTS);
    const fresh = await seedPendingMember(listId, "new@example.com");

    const due = await pendingConfirmations(50);

    expect(due.map((row) => row.id)).toContain(fresh);
    expect(due.map((row) => row.id)).not.toContain(exhausted);
  });

  it("puts the rows that have failed least at the front of the batch", async () => {
    const listId = await seedList();
    const tried = await seedPendingMember(listId, "tried@example.com", 2);
    const untried = await seedPendingMember(listId, "untried@example.com", 0);

    const due = await pendingConfirmations(50);

    expect(due[0]!.id).toBe(untried);
    expect(due.map((row) => row.id)).toContain(tried);
  });

  it("counts the attempt when signing the token throws, which is the failure that matters", async () => {
    // The worker had no BETTER_AUTH_SECRET in production, so signSubjectToken threw on every
    // membership — before the counter, when it was placed after the token mint. The row stayed
    // on zero attempts and came back in the very next batch, forever. Double opt-in was dead and
    // the cap did nothing.
    const listId = await seedList();
    const id = await seedPendingMember(listId, "someone@example.com");

    const secret = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      await expect(sendConfirmation(id)).rejects.toThrow("BETTER_AUTH_SECRET");
    } finally {
      if (secret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = secret;
    }

    const [after] = await db.select().from(listMemberships).where(eq(listMemberships.id, id));
    expect(after!.confirmationAttempts).toBe(1);
  });

  it("counts the attempt even when the send fails", async () => {
    // The attempt is counted before the send, so a throw still spends one. Counting after a
    // successful send only would leave a permanently failing row on zero forever.
    const listId = await seedList();
    const id = await seedPendingMember(listId, "someone@example.com");

    await sendConfirmation(id);

    const [after] = await db.select().from(listMemberships).where(eq(listMemberships.id, id));
    expect(after!.confirmationAttempts).toBe(1);
  });
});
