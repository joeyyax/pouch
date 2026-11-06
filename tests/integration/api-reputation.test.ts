import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { dbNow } from "@/lib/db/clock";
import { messages, type MessageStatus } from "@/lib/db/schema";
import { newId } from "@/lib/ids";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { readDomainStanding, readOrganizationReputation } from "@/lib/reputation/read";
import { GET as list } from "@/app/api/v1/domains/route";
import { GET as read } from "@/app/api/v1/domains/[id]/route";
import { GET as reputation } from "@/app/api/v1/reputation/route";
import { addDomainKey, resetDatabase, seedFixture, type Fixture } from "./fixtures";

vi.mock("@/lib/reputation/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reputation/read")>();
  return {
    ...actual,
    readDomainStanding: vi.fn(actual.readDomainStanding),
    readOrganizationReputation: vi.fn(actual.readOrganizationReputation),
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;

interface DomainBody {
  id: string;
  name: string;
  standing: string;
  standing_reason: string | null;
}

let fixture: Fixture;

function get(secret: string, path: string): Request {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${secret}` } });
}

async function insertMessages(domainId: string, count: number, status: MessageStatus, createdAt: Date) {
  await db.insert(messages).values(
    Array.from({ length: count }, () => ({
      id: newId("message"),
      organizationId: fixture.organizationId,
      domainId,
      status,
      fromAddress: "hi@example.com",
      recipients: ["person@example.net"],
      subject: "Hello",
      envelope: { from: "hi@example.com", fromName: null, to: ["person@example.net"], cc: [], bcc: [], replyTo: [], headers: {}, attachmentCount: 0 },
      tags: [],
      createdAt,
    })),
  );
}

/** 2.2% bounces in each of the last two weeks: at risk, short of the stall line. */
async function atRisk(domainId: string) {
  const now = await dbNow();
  for (const daysAgo of [1, 8]) {
    const createdAt = new Date(now.getTime() - daysAgo * DAY_MS);
    await insertMessages(domainId, 978, "delivered", createdAt);
    await insertMessages(domainId, 22, "bounced", createdAt);
  }
}

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
  vi.mocked(readDomainStanding).mockClear();
  vi.mocked(readOrganizationReputation).mockClear();
});

describe("standing on domain responses", () => {
  it("carries the standing and its reason on GET /v1/domains/:id", async () => {
    await atRisk(fixture.domainId);

    const body = (await (await read(get(fixture.secret, `/v1/domains/${fixture.domainId}`), { params: Promise.resolve({ id: fixture.domainId }) })).json()) as DomainBody;

    expect(body.standing).toBe("at_risk");
    expect(body.standing_reason).toMatch(/example\.com.*\.$/);
  });

  it("gives each listed domain its own standing from one organization read", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await addDomainKey(fixture, "third.example.com");
    await atRisk(second.domainId);

    const body = (await (await list(get(fixture.secret, "/v1/domains"))).json()) as { data: DomainBody[] };
    const byName = new Map(body.data.map((domain) => [domain.name, domain]));

    expect(byName.get("second.example.com")).toMatchObject({ standing: "at_risk" });
    expect(byName.get("second.example.com")?.standing_reason).toBeTruthy();
    expect(byName.get("example.com")).toMatchObject({ standing: "healthy", standing_reason: null });
    expect(byName.get("third.example.com")).toMatchObject({ standing: "healthy", standing_reason: null });
    expect(readOrganizationReputation).toHaveBeenCalledTimes(1);
    expect(readDomainStanding).not.toHaveBeenCalled();
  });
});

describe("GET /v1/reputation", () => {
  it("returns the organization's standing and names the domains behind it", async () => {
    const second = await addDomainKey(fixture, "second.example.com");
    await atRisk(second.domainId);

    const response = await reputation(get(fixture.secret, "/v1/reputation"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      object: "reputation",
      subject: { type: "organization", id: fixture.organizationId, name: "Test" },
      standing: "at_risk",
      reason: "second.example.com needs a look.",
      findings: [],
      domains: [{ id: second.domainId, name: "second.example.com", standing: "at_risk" }],
    });
  });

  it("reads healthy with no reason when nothing needs a look", async () => {
    const body = await (await reputation(get(fixture.secret, "/v1/reputation"))).json();

    expect(body).toMatchObject({ standing: "healthy", reason: null, findings: [], domains: [] });
  });

  it("refuses a key scoped to specific domains", async () => {
    const scoped = await addDomainKey(fixture, "second.example.com");

    const response = await reputation(get(scoped.secret, "/v1/reputation"));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("key_not_scoped");
  });
});
