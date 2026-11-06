import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { messageEvents, type MessageStatus } from "@/lib/db/schema";
import { readMessage } from "@/lib/dashboard/messages";
import { LIFECYCLE_RANK } from "@/lib/messages/lifecycle";
import { streamEventsForKey } from "@/lib/messages/stream";
import { GET as readEmail } from "@/app/api/v1/emails/[id]/route";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture({ scopeToDomain: false });
});

/** One instant for every event, and ids that sort against the lifecycle, so only the rank can put them right. */
async function tiedMessage(): Promise<string> {
  const id = await seedMessage(fixture, { status: "delivered", apiKeyId: fixture.key.id });
  const at = new Date("2026-10-01T12:00:00.123456Z");
  const steps: [string, MessageStatus][] = [
    ["evt_c_queued", "queued"],
    ["evt_b_sent", "sent"],
    ["evt_a_delivered", "delivered"],
  ];
  await db.insert(messageEvents).values(
    steps.map(([eventId, status]) => ({ id: `${eventId}_${id}`, organizationId: fixture.organizationId, messageId: id, status, occurredAt: at })),
  );
  return id;
}

describe("LIFECYCLE_RANK", () => {
  it("puts each status after every status that can lead to it", () => {
    expect(LIFECYCLE_RANK.queued).toBeLessThan(LIFECYCLE_RANK.sent);
    expect(LIFECYCLE_RANK.sent).toBeLessThan(LIFECYCLE_RANK.deferred);
    expect(LIFECYCLE_RANK.deferred).toBeLessThan(LIFECYCLE_RANK.delivered);
    expect(LIFECYCLE_RANK.delivered).toBeLessThan(LIFECYCLE_RANK.complained);
    expect(LIFECYCLE_RANK.delivered).toBeLessThan(LIFECYCLE_RANK.bounced);
    expect(LIFECYCLE_RANK.queued).toBeLessThan(LIFECYCLE_RANK.failed);
  });
});

describe("events that share a timestamp", () => {
  it("read in lifecycle order on the API, the dashboard and the stream", async () => {
    const id = await tiedMessage();

    const api = (await (
      await readEmail(new Request(`http://localhost/v1/emails/${id}?fields=events`, { headers: { authorization: `Bearer ${fixture.secret}` } }), {
        params: Promise.resolve({ id }),
      })
    ).json()) as { events: { status: string }[] };
    expect(api.events.map((event) => event.status)).toEqual(["queued", "sent", "delivered"]);

    const detail = await readMessage(fixture.organizationId, id);
    expect(detail!.events.map((event) => event.status)).toEqual(["delivered", "sent", "queued"]);

    const caller = { organizationId: fixture.organizationId, domainIds: [], mode: "live" as const };
    const streamed = await streamEventsForKey(caller, { messageId: id });
    expect(streamed.map((row) => row.event.status)).toEqual(["queued", "sent", "delivered"]);
  });

  it("resume after a cursor at the same instant without skipping or repeating", async () => {
    const id = await tiedMessage();
    const caller = { organizationId: fixture.organizationId, domainIds: [], mode: "live" as const };
    const [first] = await streamEventsForKey(caller, { messageId: id, limit: 1 });
    const rest = await streamEventsForKey(caller, { messageId: id, after: { occurredAt: first!.event.occurredAt, id: first!.event.id } });
    expect(rest.map((row) => row.event.status)).toEqual(["sent", "delivered"]);
  });
});
