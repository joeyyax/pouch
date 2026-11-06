import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { activity, apiKeys, domains, messages, organizations, providers } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { workerActor } from "@/lib/activity/record";
import { deleteOrganization } from "@/lib/organizations/delete";
import { DELETE as removeOrganization } from "@/app/api/v1/admin/organizations/[id]/route";
import { seedAdmin, seedSharedSes, SES_CREDENTIALS } from "./admin-fixtures";
import {
  addDomainKeyFor,
  addProvider,
  resetDatabase,
  seedFixture,
  seedMessage,
  seedSystemOrganization,
  type Fixture,
} from "./fixtures";

const { FakeCommand, sesSend, snsSend } = vi.hoisted(() => {
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return { FakeCommand, sesSend: vi.fn(), snsSend: vi.fn() };
});

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send(command: InstanceType<typeof FakeCommand>) {
      return sesSend(command);
    }
  },
  SendEmailCommand: class extends FakeCommand {},
  CreateEmailIdentityCommand: class extends FakeCommand {},
  GetEmailIdentityCommand: class extends FakeCommand {},
  DeleteEmailIdentityCommand: class extends FakeCommand {},
  PutEmailIdentityMailFromAttributesCommand: class extends FakeCommand {},
  CreateConfigurationSetCommand: class extends FakeCommand {},
  DeleteConfigurationSetCommand: class extends FakeCommand {},
  CreateConfigurationSetEventDestinationCommand: class extends FakeCommand {},
}));

vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    send(command: InstanceType<typeof FakeCommand>) {
      return snsSend(command);
    }
  },
  CreateTopicCommand: class extends FakeCommand {},
  DeleteTopicCommand: class extends FakeCommand {},
  SubscribeCommand: class extends FakeCommand {},
  ConfirmSubscriptionCommand: class extends FakeCommand {},
  SetTopicAttributesCommand: class extends FakeCommand {},
}));

let fixture: Fixture;

beforeEach(async () => {
  await resetDatabase();
  sesSend.mockReset();
  sesSend.mockResolvedValue({});
  snsSend.mockReset();
  snsSend.mockResolvedValue({});
  fixture = await seedFixture();
});

async function organizationExists(id: string): Promise<boolean> {
  return (await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, id))).length > 0;
}

/** An SES-backed domain in the fixture's organization, so a provider call is real code. */
async function sesDomain(name: string): Promise<{ providerId: string; domainId: string }> {
  const { providerId } = await addProvider(fixture, {
    providerAdapter: "ses",
    name: `ses-${name}`,
    credentials: SES_CREDENTIALS,
  });
  const { domainId } = await addDomainKeyFor(fixture, providerId, name);
  return { providerId, domainId };
}

/** Makes `DeleteEmailIdentity` fail for one identity and answer for every other call. */
function failIdentityDelete(name: string): void {
  sesSend.mockImplementation(async (command: InstanceType<typeof FakeCommand>) => {
    if (command.constructor.name === "DeleteEmailIdentityCommand" && command.input.EmailIdentity === name) {
      throw Object.assign(new Error("Rate exceeded."), { name: "TooManyRequestsException" });
    }
    return {};
  });
}

describe("deleting an organization", () => {
  it("takes its domains, providers, keys and send history with it", async () => {
    await seedMessage(fixture);
    const other = await seedFixture();
    await seedMessage(other);

    const result = await deleteOrganization(fixture.organizationId, workerActor());

    expect(result).toMatchObject({ id: fixture.organizationId, deleted: true, domains: 1, messages: 1 });
    expect(await organizationExists(fixture.organizationId)).toBe(false);
    expect(await db.select().from(domains).where(eq(domains.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select().from(providers).where(eq(providers.organizationId, fixture.organizationId))).toHaveLength(0);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.id, fixture.key.id))).toHaveLength(0);
    expect(await db.select().from(messages).where(eq(messages.organizationId, fixture.organizationId))).toHaveLength(0);

    expect(await organizationExists(other.organizationId)).toBe(true);
    expect(await db.select().from(messages).where(eq(messages.organizationId, other.organizationId))).toHaveLength(1);
  });

  it("never touches a row that belongs to the service", async () => {
    const sharedId = await seedSharedSes();
    const admin = await seedAdmin();

    await deleteOrganization(fixture.organizationId, workerActor());

    expect(await db.select().from(providers).where(eq(providers.id, sharedId))).toHaveLength(1);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.id, admin.keyId))).toHaveLength(1);
  });

  it("records the delete against no organization, so the row outlives what it names", async () => {
    await deleteOrganization(fixture.organizationId, workerActor());

    const [row] = await db
      .select()
      .from(activity)
      .where(and(isNull(activity.organizationId), eq(activity.action, "organization.deleted")));
    expect(row).toMatchObject({ appliesTo: fixture.organizationId, subjectLabel: "Test" });
  });

  it("refuses while mail is waiting to send, and says how much", async () => {
    await seedMessage(fixture, { status: "queued" });

    await expect(deleteOrganization(fixture.organizationId, workerActor())).rejects.toMatchObject({
      code: "organization_in_use",
      message: expect.stringContaining("1 message waiting to send"),
    });
    expect(await organizationExists(fixture.organizationId)).toBe(true);
    expect(await db.select().from(domains).where(eq(domains.organizationId, fixture.organizationId))).toHaveLength(1);
  });

  it("deletes an organization whose mail has already left", async () => {
    await seedMessage(fixture, { status: "delivered" });
    await seedMessage(fixture, { status: "bounced" });

    await expect(deleteOrganization(fixture.organizationId, workerActor())).resolves.toMatchObject({ messages: 2 });
  });

  it("refuses the organization holding the domain the service sends its own mail from", async () => {
    const system = await seedSystemOrganization();

    await expect(deleteOrganization(system.organizationId, workerActor())).rejects.toMatchObject({
      code: "organization_in_use",
      message: expect.stringContaining("Pouch sends its own mail from"),
    });
    expect(await organizationExists(system.organizationId)).toBe(true);
  });
});

describe("a provider that won't let go", () => {
  it("leaves the organization and the unremoved domain in place, and keeps what it holds", async () => {
    const first = await sesDomain("first.example.net");
    const second = await sesDomain("second.example.net");
    await seedMessage({ organizationId: fixture.organizationId, domainId: second.domainId });
    failIdentityDelete("second.example.net");

    await expect(deleteOrganization(fixture.organizationId, workerActor())).rejects.toMatchObject({
      code: "provider_unavailable",
    });

    expect(await organizationExists(fixture.organizationId)).toBe(true);
    expect(await db.select().from(domains).where(eq(domains.id, first.domainId))).toHaveLength(0);
    expect(await db.select().from(domains).where(eq(domains.id, second.domainId))).toHaveLength(1);
    // The failing domain's transaction rolled back whole: its messages are still there with it.
    expect(await db.select().from(messages).where(eq(messages.domainId, second.domainId))).toHaveLength(1);
  });

  it("finishes on the next run once the provider answers", async () => {
    await sesDomain("first.example.net");
    await sesDomain("second.example.net");
    failIdentityDelete("second.example.net");
    await expect(deleteOrganization(fixture.organizationId, workerActor())).rejects.toThrow(ApiError);

    sesSend.mockResolvedValue({});
    await expect(deleteOrganization(fixture.organizationId, workerActor())).resolves.toMatchObject({ deleted: true });

    expect(await organizationExists(fixture.organizationId)).toBe(false);
    expect(await db.select().from(providers).where(eq(providers.organizationId, fixture.organizationId))).toHaveLength(0);
  });
});

describe("DELETE /v1/admin/organizations/:id", () => {
  function request(secret: string, id: string): Request {
    return new Request(`http://localhost/v1/admin/organizations/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${secret}` },
    });
  }

  it("deletes the organization and counts what went with it", async () => {
    const admin = await seedAdmin();
    await seedMessage(fixture);

    const response = await removeOrganization(request(admin.secret, fixture.organizationId), {
      params: Promise.resolve({ id: fixture.organizationId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: fixture.organizationId, deleted: true, domains: 1, messages: 1 });
    expect(await organizationExists(fixture.organizationId)).toBe(false);
  });

  it("answers 422 with what's blocking it", async () => {
    const admin = await seedAdmin();
    await seedMessage(fixture, { status: "queued" });

    const response = await removeOrganization(request(admin.secret, fixture.organizationId), {
      params: Promise.resolve({ id: fixture.organizationId }),
    });
    const body = (await response.json()) as { error: { code: string; detail?: { reason?: string } } };

    expect(response.status).toBe(422);
    expect(body.error.code).toBe("organization_in_use");
    expect(body.error.detail?.reason).toBe("mail_in_flight");
  });

  it("answers 404 for an organization that isn't there", async () => {
    const admin = await seedAdmin();

    const response = await removeOrganization(request(admin.secret, "org_missing"), {
      params: Promise.resolve({ id: "org_missing" }),
    });

    expect(response.status).toBe(404);
  });
});
