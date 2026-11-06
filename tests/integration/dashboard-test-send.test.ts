import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { domains } from "@/lib/db/schema";
import { acceptDashboardMessage } from "@/lib/messages/create";
import type { DomainLayout } from "@/lib/domains/layout";
import type { SendEmailRequest } from "@/lib/schemas/email";
import { resetDatabase, seedFixture } from "./fixtures";

const layout: DomainLayout = {
  brandName: "Pouch",
  logoUrl: "https://example.test/mark.png",
  accent: "#1d46f5",
  footer: "Pouch · Portland, OR",
};

beforeEach(resetDatabase);

describe("acceptDashboardMessage", () => {
  it("queues a test message with apiKeyId null and testMode false", async () => {
    const fixture = await seedFixture();

    const request: SendEmailRequest = {
      from: "noreply@example.com",
      to: ["operator@example.test"],
      subject: "Hello from the dashboard",
      html: "<p>Hi</p>",
      tags: ["dashboard-test"],
    };

    const { message, replayed } = await acceptDashboardMessage(fixture.organizationId, request, null);

    expect(replayed).toBe(false);
    expect(message.status).toBe("queued");
    expect(message.apiKeyId).toBeNull();
    expect(message.testMode).toBe(false);
    expect(message.organizationId).toBe(fixture.organizationId);
    expect(message.domainId).toBe(fixture.domainId);
    expect(message.tags).toEqual(["dashboard-test"]);
  });

  it("wraps html in the domain's layout when the layout flag is on", async () => {
    const fixture = await seedFixture();
    await db.update(domains).set({ layout }).where(eq(domains.id, fixture.domainId));

    const request: SendEmailRequest = {
      from: "noreply@example.com",
      to: ["operator@example.test"],
      subject: "Framed",
      html: "<p>Your invite is ready.</p>",
      layout: true,
    };

    const { message } = await acceptDashboardMessage(fixture.organizationId, request, null);

    expect(message.layout).toBe(true);
    expect(message.apiKeyId).toBeNull();
  });
});