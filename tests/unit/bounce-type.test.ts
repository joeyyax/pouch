import { describe, expect, it } from "vitest";
import { bounceTypeLabel } from "@/lib/reputation/bounce-type";

describe("bounceTypeLabel", () => {
  it("words the subtype plainly", () => {
    expect(bounceTypeLabel("Permanent/NoEmail")).toBe("Mailbox doesn't exist");
    expect(bounceTypeLabel("Transient/MailboxFull")).toBe("Mailbox full");
  });

  it("says nothing for a subtype that adds nothing, or no bounce type at all", () => {
    expect(bounceTypeLabel("Permanent/General")).toBeNull();
    expect(bounceTypeLabel("Permanent")).toBeNull();
    expect(bounceTypeLabel(null)).toBeNull();
  });

  it("passes an unknown subtype through rather than hiding it", () => {
    expect(bounceTypeLabel("Permanent/SomethingNew")).toBe("SomethingNew");
  });
});
