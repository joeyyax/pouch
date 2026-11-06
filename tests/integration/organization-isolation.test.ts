/**
 * The load-bearing test for #89: an organization admin must never reach another
 * organization's data, by any route — including a direct id lookup against a row that
 * simply doesn't belong to their org. `resolveDashboardSession` is what decides which
 * organization a request is scoped to, and it must resolve through `memberships`, never
 * through `users.organization_id`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { encryptCredentials } from "@/lib/providers";
import { listProviderOptions } from "@/lib/dashboard/domains";
import { activity } from "@/lib/db/schema/activity";
import { readActivity } from "@/lib/activity/query";
import { recordActivity, userActor } from "@/lib/activity/record";
import { readDomain } from "@/lib/dashboard/domains";
import { readKey } from "@/lib/dashboard/keys";
import { readMessage } from "@/lib/dashboard/messages";
import { resolveDashboardSession } from "@/lib/dashboard/session";
import { listSuppressions } from "@/lib/dashboard/suppressions";
import { ROLES } from "@/lib/auth/permissions";
import { newId } from "@/lib/ids";
import { addSuppression, memberOf, resetDatabase, seedFixture, type Fixture } from "./fixtures";
import { acceptDashboardMessage } from "@/lib/messages/create";
import type { SendEmailRequest } from "@/lib/schemas/email";

let orgA: Fixture;
let orgB: Fixture;

beforeEach(async () => {
  await resetDatabase();
  orgA = await seedFixture();
  orgB = await seedFixture();
});

describe("resolveDashboardSession", () => {
  it("resolves the organization through membership, not users.organization_id", async () => {
    // users.organization_id points at the same org, so only the membership row can fail this.
    const userId = await memberOf(orgA.organizationId, ROLES.OWNER);

    const session = await resolveDashboardSession(userId, { name: "Org Admin", email: `${userId}@example.com`, admin: false });

    expect(session?.organizationId).toBe(orgA.organizationId);
    expect(session?.role).toBe(ROLES.OWNER);
  });

  it("returns null for a user with no membership at all", async () => {
    const session = await resolveDashboardSession("nobody", { name: "Nobody", email: "nobody@example.com", admin: false });
    expect(session).toBeNull();
  });
});

describe("cross-organization isolation", () => {
  it("an org admin cannot read another organization's domain by id", async () => {
    const domain = await readDomain({ organizationId: orgA.organizationId, domainIds: [], actor: userActor("someone", "Someone") }, orgB.domainId);
    expect(domain).toBeNull();
  });

  it("an org admin cannot read another organization's api key by id", async () => {
    const key = await readKey(orgA.organizationId, orgB.key.id, "UTC");
    expect(key).toBeNull();
  });

  it("an org admin cannot read another organization's message by id", async () => {
    const request: SendEmailRequest = {
      from: "noreply@example.com",
      to: ["recipient@example.test"],
      subject: "hello",
      html: "<p>hi</p>",
    };
    const { message } = await acceptDashboardMessage(orgB.organizationId, request, null);

    const found = await readMessage(orgA.organizationId, message.id);
    expect(found).toBeNull();
  });

  it("an org admin cannot see another organization's suppressions", async () => {
    await addSuppression(orgB.organizationId, "blocked@example.com");

    const page = await listSuppressions(orgA.organizationId);
    expect(page.rows).toHaveLength(0);
  });

  it("an org admin sees only its own tenant provider, never the shared provider or another tenant", async () => {
    const sharedId = newId("provider");
    const credentials = encryptCredentials({ accessKeyId: "AKIA", secretAccessKey: "admin-secret", region: "us-west-2" });
    await db.insert(providers).values({ id: sharedId, adapter: "ses", name: "Hosted", credentials, shared: true });
    const tenantIds = [newId("provider"), newId("provider")];
    await db.insert(providers).values(
      [orgA, orgB].map((org, index) => ({
        id: tenantIds[index]!,
        organizationId: org.organizationId,
        adapter: "ses",
        name: "Hosted",
        credentials,
        sharedProviderId: sharedId,
        settings: { tenantName: `org_${index}` },
      })),
    );

    const visible = (await listProviderOptions(orgA.organizationId)).map((provider) => provider.id);
    expect(visible).toContain(tenantIds[0]);
    expect(visible).not.toContain(tenantIds[1]);
    expect(visible).not.toContain(sharedId);
    expect((await listProviderOptions(orgB.organizationId)).map((provider) => provider.id)).not.toContain(sharedId);
  });

  it("an org admin cannot read another organization's activity row by id", async () => {
    await recordActivity({
      organizationId: orgB.organizationId,
      action: "key.revoked",
      actor: userActor("someone", "Someone"),
      appliesTo: orgB.key.id,
      subjectLabel: orgB.key.name,
    });

    const [row] = await db.select().from(activity).where(eq(activity.organizationId, orgB.organizationId)).limit(1);

    const found = await readActivity(orgA.organizationId, row!.id);
    expect(found).toBeNull();
  });
});
