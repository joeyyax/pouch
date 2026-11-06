import { beforeEach, describe, expect, it } from "vitest";
import { listMessagePage } from "@/lib/dashboard/messages";
import { addDomainKey, resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

const LIMIT = 3;
let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

/** Walks every older page from the newest, as the Older button does. */
async function walk(filters: Parameters<typeof listMessagePage>[1] = {}) {
  const pages: string[][] = [];
  let before: string | undefined;
  for (let i = 0; i < 20; i += 1) {
    const page = await listMessagePage(fixture.organizationId, filters, before ? { before } : {}, LIMIT);
    pages.push(page.rows.map((row) => row.id));
    if (!page.hasOlder) break;
    before = page.rows.at(-1)?.id;
  }
  return pages;
}

describe("listMessagePage", () => {
  it("pages rows sharing a timestamp without skipping or repeating one", async () => {
    const at = new Date(Date.now() - 60 * 60 * 1000);
    const ids: string[] = [];
    for (let i = 0; i < 8; i += 1) ids.push(await seedMessage(fixture, { createdAt: at }));

    const pages = await walk();
    expect(pages.map((page) => page.length)).toEqual([3, 3, 2]);
    expect(pages.flat().sort()).toEqual([...ids].sort());
  });

  it("steps back to the newer page and counts what's above it", async () => {
    const base = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 8; i += 1) await seedMessage(fixture, { createdAt: new Date(base - i * 1000) });

    const first = await listMessagePage(fixture.organizationId, {}, {}, LIMIT);
    expect(first.offset).toBe(0);
    const second = await listMessagePage(fixture.organizationId, {}, { before: first.rows.at(-1)?.id }, LIMIT);
    expect(second.offset).toBe(3);
    const third = await listMessagePage(fixture.organizationId, {}, { before: second.rows.at(-1)?.id }, LIMIT);
    expect(third.offset).toBe(6);
    expect(third.hasOlder).toBe(false);

    const back = await listMessagePage(fixture.organizationId, {}, { after: third.rows[0]?.id }, LIMIT);
    expect(back.rows.map((row) => row.id)).toEqual(second.rows.map((row) => row.id));
    expect(back.offset).toBe(3);

    // Short of a full page above, Newer lands on the newest page rather than a partial one.
    const top = await listMessagePage(fixture.organizationId, {}, { after: second.rows[0]?.id }, LIMIT);
    expect(top.rows.map((row) => row.id)).toEqual(first.rows.map((row) => row.id));
    expect(top.offset).toBe(0);
  });

  it("keeps every filter across pages", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    const at = new Date(Date.now() - 60 * 60 * 1000);
    const wanted: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      wanted.push(
        await seedMessage(
          { organizationId: fixture.organizationId, domainId: second.domainId },
          { status: "bounced", createdAt: at, apiKeyId: second.key.id },
        ),
      );
      await seedMessage({ organizationId: fixture.organizationId, domainId: second.domainId }, { status: "delivered", createdAt: at });
      await seedMessage(fixture, { status: "bounced", createdAt: at });
    }

    const pages = await walk({ domain: "second.example.com", keyId: second.key.id, statuses: ["bounced"] });
    expect(pages.flat().sort()).toEqual([...wanted].sort());
  });
});
