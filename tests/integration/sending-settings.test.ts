import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { adminActor } from "@/lib/activity/record";
import { createApiKey } from "@/lib/api/key-lifecycle";
import { resetRateLimitMemory } from "@/lib/api/rate-limit";
import { acceptMessage } from "@/lib/messages/create";
import type { SendEmailRequest } from "@/lib/schemas/email";
import { setSetting } from "@/lib/settings/values";
import { POST as createKeyRoute } from "@/app/api/v1/keys/route";
import { apiRequest, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const ADMIN = adminActor("usr_admin", "Admin");
const MB = 1024 * 1024;
const request: SendEmailRequest = { from: "ada@example.com", to: ["person@example.net"], subject: "Hello", html: "<p>Hi</p>" };

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  resetRateLimitMemory();
  fixture = await seedFixture({ scopeToDomain: false });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function attachment(bytes: number) {
  return { filename: "a.bin", content: Buffer.alloc(bytes, 1).toString("base64"), content_type: "application/octet-stream" };
}

describe("the largest message", () => {
  it("refuses body and attachments together past the limit, and accepts them under it", async () => {
    const send = (extra: Partial<SendEmailRequest>) => acceptMessage(fixture.key, { ...request, ...extra }, null);
    await expect(send({ attachments: [attachment(Math.floor(1.5 * MB))] })).resolves.toBeDefined();

    await setSetting("max_message_mb", 1, ADMIN);
    const refused = await send({ attachments: [attachment(Math.floor(1.5 * MB))] }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "attachment_too_large", field: "attachments", detail: { limit_bytes: MB } });

    await expect(send({ html: `<p>${"a".repeat(MB)}</p>` })).rejects.toMatchObject({ code: "attachment_too_large", field: "html" });
    await expect(send({ attachments: [attachment(MB - 2048)] })).resolves.toBeDefined();
  });

  it("only goes lower than what the providers take", async () => {
    await expect(setSetting("max_message_mb", 31, ADMIN)).rejects.toMatchObject({
      code: "validation_failed",
      message: expect.stringContaining("can't be looser than its default, 30 MB"),
    });
    await expect(setSetting("max_message_mb", 0, ADMIN)).rejects.toMatchObject({ code: "validation_failed" });
  });
});

describe("the rate limit for new keys", () => {
  async function createKey(body: Record<string, unknown>): Promise<{ id: string; rate_limit: number }> {
    const response = await createKeyRoute(apiRequest(fixture.secret, "/v1/keys", "POST", body));
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; rate_limit: number };
  }

  it("is what a key created without one gets, and never rewrites an existing key", async () => {
    expect((await createKey({ name: "before" })).rate_limit).toBe(3000);

    await setSetting("key_rate_limit_default", 120, ADMIN);
    expect((await createKey({ name: "after" })).rate_limit).toBe(120);
    expect((await createKey({ name: "chosen", rate_limit: 50 })).rate_limit).toBe(50);

    const [existing] = await db.select({ rateLimit: apiKeys.rateLimit }).from(apiKeys).where(eq(apiKeys.id, fixture.key.id));
    expect(existing!.rateLimit).toBe(3000);
  });

  it("applies to every way a key is minted", async () => {
    vi.stubEnv("KEY_RATE_LIMIT_DEFAULT", "75");
    const minted = await createApiKey({ organizationId: fixture.organizationId, name: "seeded", mode: "live", domainIds: [] });
    expect(minted.key.rateLimit).toBe(75);
  });
});
