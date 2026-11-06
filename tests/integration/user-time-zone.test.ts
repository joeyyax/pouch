import { beforeEach, describe, expect, it } from "vitest";
import { resolveDashboardSession } from "@/lib/dashboard/session";
import { ROLES } from "@/lib/auth/permissions";
import { resetDatabase, seedUser } from "./fixtures";

beforeEach(resetDatabase);

describe("user time zone", () => {
  it("reads a person with no zone as UTC", async () => {
    const { userId, organizationId } = await seedUser({ role: ROLES.OWNER });
    const session = await resolveDashboardSession(userId, { email: "a@example.com", timeZone: null }, organizationId);
    expect(session?.timeZone).toBe("UTC");
    const set = await resolveDashboardSession(userId, { email: "a@example.com", timeZone: "America/Los_Angeles" }, organizationId);
    expect(set?.timeZone).toBe("America/Los_Angeles");
  });
});
