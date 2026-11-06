/**
 * The load-bearing test for #376's org roles. Sending work is a member's job, so every
 * dashboard write has to let a member through — this catches a guard tightened by accident.
 * Organization settings are owner-only, and that refusal is the one a role check still makes.
 *
 * Also proves the two axes stay orthogonal: the `admin` flag on a user must not leak into the
 * org-role check, and an org role must not leak into the admin check.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, users } from "@/lib/db/schema";
import { ROLES } from "@/lib/auth/permissions";
import { requireAdmin } from "@/lib/auth/admin";
import { form, memberOf, resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { deleteOrganizationAction, updateOrganizationSettingsAction } from "@/app/(app)/settings/actions";
import {
  addDomainAction,
  cancelMoveAction,
  deleteDomainAction,
  moveDomainAction,
  releaseStallAction,
  saveLayoutAction,
  sendTestEmailAction,
  uploadLayoutLogoAction,
  verifyDomainAction,
} from "@/app/(app)/domains/actions";
import {
  createKeyAction,
  createWebhookEndpointAction,
  deleteWebhookEndpointAction,
  revealWebhookSecretAction,
  revokeKeyAction,
  rotateWebhookSecretAction,
  sendTestWebhookEventAction,
  toggleWebhookDisabledAction,
  updateWebhookEndpointAction,
} from "@/app/(app)/keys/actions";
import { addSuppressionAction, removeSuppressionAction } from "@/app/(app)/suppressions/actions";
import { createListAction } from "@/app/(app)/lists/actions";
import { redeliverInboundAction } from "@/app/(app)/inbound/actions";
import { createEndpoint } from "@/lib/webhooks/endpoints";
import { requireExportSession } from "@/lib/exports/session";
import { addSuppression as seedSuppression } from "./fixtures";

const sessionState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth/session", async () => (await import("./fixtures")).adminSessionModule(sessionState));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
// These actions run outside a Next.js request, so there's no cookie jar for `requireOrganization`
// to read — the same as a real request with nothing chosen yet, and it falls back the same way.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {} }),
}));

let fixture: Fixture;
let ownerId: string;
let memberId: string;

beforeEach(async () => {
  await resetDatabase();
  fixture = await seedFixture();
  ownerId = await memberOf(fixture.organizationId, ROLES.OWNER);
  memberId = await memberOf(fixture.organizationId, ROLES.MEMBER);
  sessionState.userId = null;
});

const idle = { status: "idle" as const };

const REFUSED = /Your role doesn't let you|You need to be an owner/;

interface GuardedAction {
  name: string;
  run: (f: FormData) => Promise<unknown>;
  form: () => FormData;
}

/** Ran and wasn't refused by the role check. Anything else it throws is the action's own business. */
async function passesGate(action: GuardedAction): Promise<void> {
  const outcome = await action.run(action.form()).catch((error: Error) => error);
  if (outcome instanceof Error) {
    expect(outcome.message).not.toMatch(REFUSED);
  }
}

describe("every dashboard write is member work", () => {
  const actions: GuardedAction[] = [
    { name: "addDomainAction", run: (f) => addDomainAction(idle, f), form: () => form({ name: "new.example.com", providerAccountId: fixture.providerId }) },
    { name: "verifyDomainAction", run: (f) => verifyDomainAction(idle, f), form: () => form({ id: fixture.domainId }) },
    { name: "moveDomainAction", run: (f) => moveDomainAction(idle, f), form: () => form({ id: fixture.domainId, providerAccountId: fixture.providerId }) },
    { name: "cancelMoveAction", run: (f) => cancelMoveAction(idle, f), form: () => form({ id: fixture.domainId }) },
    { name: "deleteDomainAction", run: (f) => deleteDomainAction(idle, f), form: () => form({ id: fixture.domainId }) },
    { name: "releaseStallAction", run: (f) => releaseStallAction(idle, f), form: () => form({ id: fixture.domainId }) },
    { name: "saveLayoutAction", run: (f) => saveLayoutAction(idle, f), form: () => form({ id: fixture.domainId, brandName: "Acme" }) },
    { name: "uploadLayoutLogoAction", run: (f) => uploadLayoutLogoAction(idle, f), form: () => form({ id: fixture.domainId }) },
    { name: "sendTestEmailAction", run: (f) => sendTestEmailAction(idle, f), form: () => form({ domainId: fixture.domainId }) },

    { name: "createKeyAction", run: (f) => createKeyAction(idle, f), form: () => form({ name: "key", mode: "live" }) },
    { name: "revokeKeyAction", run: (f) => revokeKeyAction(idle, f), form: () => form({ id: fixture.key.id }) },
    {
      name: "createWebhookEndpointAction",
      run: (f) => createWebhookEndpointAction(idle, f),
      form: () => form({ keyId: fixture.key.id, url: "https://example.com/hook" }),
    },

    { name: "addSuppressionAction", run: (f) => addSuppressionAction(idle, f), form: () => form({ address: "new-block@example.com" }) },
    { name: "createListAction", run: (f) => createListAction(idle, f), form: () => form({ domain_id: fixture.domainId, name: "Announcements" }) },
    { name: "redeliverInboundAction", run: (f) => redeliverInboundAction(idle, f), form: () => form({ id: "inb_missing" }) },
  ];

  for (const action of actions) {
    it(`${action.name}: lets a member past the gate`, async () => {
      sessionState.userId = memberId;
      await passesGate(action);
    });
  }
});

describe("webhook endpoint actions, which need an existing endpoint", () => {
  let endpointId: string;

  beforeEach(async () => {
    const { endpoint } = await createEndpoint({
      organizationId: fixture.organizationId,
      apiKeyId: fixture.key.id,
      url: "https://example.com/hook",
      events: ["email.delivered"],
      description: null,
    });
    endpointId = endpoint.id;
  });

  function endpointActions(id: string): GuardedAction[] {
    return [
      { name: "updateWebhookEndpointAction", run: (f) => updateWebhookEndpointAction(idle, f), form: () => form({ keyId: fixture.key.id, endpointId: id, events: "email.delivered" }) },
      { name: "revealWebhookSecretAction", run: (f) => revealWebhookSecretAction(idle, f), form: () => form({ endpointId: id }) },
      { name: "rotateWebhookSecretAction", run: (f) => rotateWebhookSecretAction(idle, f), form: () => form({ keyId: fixture.key.id, endpointId: id }) },
      { name: "toggleWebhookDisabledAction", run: (f) => toggleWebhookDisabledAction(idle, f), form: () => form({ keyId: fixture.key.id, endpointId: id, disable: "true" }) },
      { name: "sendTestWebhookEventAction", run: (f) => sendTestWebhookEventAction(idle, f), form: () => form({ keyId: fixture.key.id, endpointId: id }) },
      { name: "deleteWebhookEndpointAction", run: (f) => deleteWebhookEndpointAction(idle, f), form: () => form({ keyId: fixture.key.id, endpointId: id }) },
    ];
  }

  it("lets a member past the gate on every webhook endpoint action, secret reveal included", async () => {
    sessionState.userId = memberId;
    for (const action of endpointActions(endpointId)) {
      await passesGate(action);
    }
  });
});

describe("removing a suppression is member work now, not account-level", () => {
  const SUPPRESSED = "blocked@example.com";

  beforeEach(async () => {
    await seedSuppression(fixture.organizationId, SUPPRESSED);
  });

  it("lets a member remove one", async () => {
    sessionState.userId = memberId;
    const result = await removeSuppressionAction(idle, form({ address: SUPPRESSED }));
    expect(result).toMatchObject({ status: "ok" });
  });
});

describe("organization settings are owner-only", () => {
  const settings = () => form({ bodyRetentionDays: "30" });

  it("refuses a member", async () => {
    sessionState.userId = memberId;
    await expect(updateOrganizationSettingsAction(idle, settings())).rejects.toThrow(/You need to be an owner/);
  });

  it("allows an owner", async () => {
    sessionState.userId = ownerId;
    const result = await updateOrganizationSettingsAction(idle, settings());
    expect(result).toMatchObject({ status: "ok" });
  });
});

describe("deleting the organization is owner-only", () => {
  it("refuses a member", async () => {
    sessionState.userId = memberId;
    await expect(deleteOrganizationAction(idle, form({ id: fixture.organizationId }))).rejects.toThrow(
      /You need to be an owner/,
    );
  });

  it("refuses an owner an organization they aren't acting in", async () => {
    sessionState.userId = ownerId;
    const other = await seedFixture();
    const result = await deleteOrganizationAction(idle, form({ id: other.organizationId }));
    expect(result).toMatchObject({ status: "error" });
    expect(await db.select().from(organizations).where(eq(organizations.id, other.organizationId))).toHaveLength(1);
  });
});

describe("exporting is a write, and a member may do it", () => {
  it("resolves an export session for a member", async () => {
    sessionState.userId = memberId;
    expect(await requireExportSession()).not.toBeInstanceOf(Response);
  });
});

describe("the admin flag and the org-role check stay orthogonal", () => {
  it("a service admin who is only a member here is still refused an owner action", async () => {
    sessionState.userId = await memberOf(fixture.organizationId, ROLES.MEMBER, true);

    await expect(updateOrganizationSettingsAction(idle, form({ bodyRetentionDays: "30" }))).rejects.toThrow(
      /You need to be an owner/,
    );
  });

  it("an owner who is not a service admin is refused an admin-only action", async () => {
    sessionState.userId = ownerId;
    const [row] = await db.select().from(users).where(eq(users.id, ownerId)).limit(1);
    expect(row?.admin).toBe(false);

    // requireAdmin reads the session through the same mocked getSession above, so this
    // proves an owner role carries no service-wide power on its own.
    await expect(requireAdmin()).rejects.toThrow();
  });
});
