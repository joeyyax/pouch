import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { messages, providers } from "@/lib/db/schema";
import * as providersModule from "@/lib/providers";
import { encryptCredentials } from "@/lib/providers";
import { newId } from "@/lib/ids";
import { acceptMessage } from "@/lib/messages/create";
import { claimMessages } from "@/lib/messages/queue";
import { buildAdapter } from "@/lib/providers/adapters";
import { deliver } from "@/worker/send";
import { awsError, providerRow, resetDatabase, seedFixture, type Fixture } from "./fixtures";

const { sendError } = vi.hoisted(() => ({ sendError: { current: null as Error | null } }));

vi.mock("@aws-sdk/client-sesv2", () => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    SESv2Client: class {
      async send() {
        if (sendError.current) throw sendError.current;
        return { MessageId: "ses-1" };
      }
    },
    SendEmailCommand: class SendEmailCommand extends FakeCommand {},
    GetAccountCommand: class GetAccountCommand extends FakeCommand {},
  };
});

let sharedId: string;
let orgA: Fixture;
let orgB: Fixture;

async function tenantOf(fixture: Fixture): Promise<void> {
  await db
    .update(providers)
    .set({ adapter: "ses", sharedProviderId: sharedId, settings: { tenantName: `tenant-${fixture.organizationId}` } })
    .where(eq(providers.id, fixture.providerId));
}

async function sendOnce(fixture: Fixture): Promise<string> {
  const { message } = await acceptMessage(fixture.key, { from: "Ada <ada@example.com>", to: ["person@example.net"], subject: "Hi", html: "<p>Hi</p>" }, null);
  const [claimed] = await claimMessages({ workerId: "w", providerId: fixture.providerId, limit: 1 });
  await deliver(claimed!, "w");
  const [row] = await db.select().from(messages).where(eq(messages.id, message.id));
  return row!.status;
}

beforeEach(async () => {
  await resetDatabase();
  sharedId = newId("provider");
  await db.insert(providers).values({
    id: sharedId,
    adapter: "ses",
    name: "Hosted",
    credentials: encryptCredentials({ accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-west-2" }),
    shared: true,
  });
  orgA = await seedFixture();
  orgB = await seedFixture();
  await tenantOf(orgA);
  await tenantOf(orgB);
  vi.spyOn(providersModule, "adapterFor").mockImplementation((row) =>
    buildAdapter("ses", { accessKeyId: "AKIA", secretAccessKey: "secret", region: "us-west-2" }, row.settings, row.id),
  );
});
afterEach(() => {
  sendError.current = null;
  vi.restoreAllMocks();
});

describe("an SES send error's effect", () => {
  it("fails the message for an unverified MAIL FROM and holds neither the tenant nor the shared provider", async () => {
    sendError.current = awsError("MailFromDomainNotVerifiedException", 400, "Mail-From domain not verified.");

    expect(await sendOnce(orgA)).toBe("failed");

    expect((await providerRow(orgA.providerId)).backoffUntil).toBeNull();
    expect((await providerRow(sharedId)).backoffUntil).toBeNull();
    const [row] = await db.select().from(messages).where(eq(messages.organizationId, orgA.organizationId));
    expect(row!.failureReason).toContain("MAIL FROM");
  });

  it("fails the message for a resource limit and backs nothing off", async () => {
    sendError.current = awsError("LimitExceededException", 400, "There are too many instances of the specified resource type.");

    expect(await sendOnce(orgA)).toBe("failed");

    expect((await providerRow(orgA.providerId)).backoffUntil).toBeNull();
    expect((await providerRow(sharedId)).backoffUntil).toBeNull();
  });

  it("still backs off every tenant when a LimitExceeded carries SES's quota message", async () => {
    sendError.current = awsError("LimitExceededException", 400, "Daily message quota exceeded.");

    expect(await sendOnce(orgA)).toBe("queued");

    expect((await providerRow(sharedId)).backoffUntil).not.toBeNull();
  });

  it("backs off every tenant on a throttle", async () => {
    sendError.current = awsError("TooManyRequestsException", 429, "Too many requests.");

    expect(await sendOnce(orgA)).toBe("queued");

    expect((await providerRow(sharedId)).backoffUntil).not.toBeNull();
    expect((await providerRow(orgB.providerId)).backoffUntil).toBeNull();
  });

  it("holds every tenant, rather than failing the message, when the shared credentials are rejected", async () => {
    sendError.current = awsError("UnrecognizedClientException", 403, "The security token included in the request is invalid.");

    expect(await sendOnce(orgA)).toBe("queued");

    expect((await providerRow(sharedId)).backoffUntil).not.toBeNull();
  });

  it("keeps a paused tenant's backoff on that tenant", async () => {
    sendError.current = awsError("SendingPausedException", 400, "Sending is paused.");

    expect(await sendOnce(orgA)).toBe("queued");

    expect((await providerRow(orgA.providerId)).backoffUntil).not.toBeNull();
    expect((await providerRow(sharedId)).backoffUntil).toBeNull();
  });

  it("retries a request timeout instead of failing the message", async () => {
    sendError.current = awsError("RequestTimeoutException", 408, "The request timed out.");

    expect(await sendOnce(orgA)).toBe("queued");

    expect((await providerRow(orgA.providerId)).backoffUntil).toBeNull();
  });

  it("fails a rejected message without backing anything off", async () => {
    sendError.current = awsError("MessageRejected", 400, "Email address is not verified.");

    expect(await sendOnce(orgA)).toBe("failed");

    expect((await providerRow(orgA.providerId)).backoffUntil).toBeNull();
    expect((await providerRow(sharedId)).backoffUntil).toBeNull();
  });
});
