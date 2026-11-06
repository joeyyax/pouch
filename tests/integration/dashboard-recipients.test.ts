import { beforeEach, describe, expect, it } from "vitest";
import { listRecipients } from "@/lib/lists/recipients";
import { resetDatabase, seedFixture, seedMessage, type Fixture } from "./fixtures";

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
});

describe("recipients", () => {
  it("counts each address's messages by outcome", async () => {
    for (const status of ["delivered", "delivered", "bounced", "complained", "failed", "queued"] as const) {
      await seedMessage(fixture, { to: "ada@example.net", status });
    }
    await seedMessage(fixture, { to: "sam@example.net", status: "delivered" });

    const { rows } = await listRecipients(fixture.organizationId);
    const ada = rows.find((row) => row.address === "ada@example.net");
    expect(ada?.messageCount).toBe(6);
    expect(ada?.outcomes).toEqual({ delivered: 2, bounced: 1, complained: 1, failed: 1 });
    expect(rows.find((row) => row.address === "sam@example.net")?.outcomes).toEqual({ delivered: 1, bounced: 0, complained: 0, failed: 0 });
  });
});
