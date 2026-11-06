import { describe, expect, it } from "vitest";
import { tenantNameFor } from "@/lib/providers/shared";
import { newId } from "@/lib/ids";

const SES_TENANT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

describe("tenantNameFor", () => {
  it("is the organization id itself", () => {
    const id = newId("organization");

    expect(tenantNameFor(id)).toBe(id);
    expect(tenantNameFor(id)).toMatch(SES_TENANT_NAME);
  });

  it("prefixes and cleans an id that isn't one of ours", () => {
    expect(tenantNameFor("legacy.org/1")).toBe("org_legacy-org-1");
  });

  it("stays within SES's 64 characters", () => {
    const name = tenantNameFor(`org_${"a".repeat(100)}`);

    expect(name).toHaveLength(64);
    expect(name).toMatch(SES_TENANT_NAME);
  });
});
