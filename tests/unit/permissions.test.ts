import { describe, expect, it } from "vitest";
import { canWriteInOrganization, isOrgOwner, ROLES } from "@/lib/auth/permissions";

describe("isOrgOwner", () => {
  it("is true for owner alone", () => {
    expect(isOrgOwner(ROLES.OWNER)).toBe(true);
    expect(isOrgOwner(ROLES.MEMBER)).toBe(false);
  });
});

describe("canWriteInOrganization", () => {
  it("lets both roles write", () => {
    expect(canWriteInOrganization(ROLES.OWNER)).toBe(true);
    expect(canWriteInOrganization(ROLES.MEMBER)).toBe(true);
  });

  // The only thing this predicate can still refuse, and the reason it's worth keeping: the set
  // is closed, so a role the code doesn't know — a retired one, a hand-edited row — writes
  // nothing rather than defaulting open.
  it("refuses a role it doesn't know, including the retired org-level admin", () => {
    expect(canWriteInOrganization("admin")).toBe(false);
    expect(canWriteInOrganization("viewer")).toBe(false);
    expect(canWriteInOrganization("")).toBe(false);
  });
});
