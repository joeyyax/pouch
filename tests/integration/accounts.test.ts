import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { mergeSettings } from "@/lib/providers";
import { resetDatabase, seedFixture } from "./fixtures";

async function settingsOf(id: string): Promise<Record<string, string>> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
  if (!row) throw new Error("provider disappeared");
  return row.settings;
}

beforeEach(resetDatabase);

describe("mergeSettings", () => {
  it("adds a key to a provider that has none", async () => {
    const fixture = await seedFixture();

    await mergeSettings(fixture.providerId, { topicArn: "arn:one" });

    expect(await settingsOf(fixture.providerId)).toEqual({ topicArn: "arn:one" });
  });

  it("keeps a key written after the caller read the provider", async () => {
    const fixture = await seedFixture({ settings: { webhookPublicKey: "key" } });
    // Stands in for a second create landing between this caller's read and its write.
    await db
      .update(providers)
      .set({ settings: { webhookPublicKey: "key", configurationSetName: "set" } })
      .where(eq(providers.id, fixture.providerId));

    await mergeSettings(fixture.providerId, { topicArn: "arn:one" });

    expect(await settingsOf(fixture.providerId)).toEqual({
      webhookPublicKey: "key",
      configurationSetName: "set",
      topicArn: "arn:one",
    });
  });

  it("overwrites only the keys it was given", async () => {
    const fixture = await seedFixture({ settings: { topicArn: "arn:old", webhookPublicKey: "key" } });

    await mergeSettings(fixture.providerId, { topicArn: "arn:new" });

    expect(await settingsOf(fixture.providerId)).toEqual({ topicArn: "arn:new", webhookPublicKey: "key" });
  });
});
