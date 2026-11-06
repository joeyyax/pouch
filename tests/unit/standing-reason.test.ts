import { describe, expect, it } from "vitest";
import { standingReason, type Finding } from "@/lib/reputation/standing";

const finding: Finding = {
  kind: "bounce_rate",
  standing: "at_risk",
  title: "Bounce rate on example.com is 2.20%",
  body: "",
  action: "",
};

describe("standingReason", () => {
  it("says nothing for a healthy subject", () => {
    expect(standingReason({ standing: "healthy", findings: [] })).toBeNull();
  });

  it("uses the lead finding as a sentence", () => {
    expect(standingReason({ standing: "at_risk", findings: [finding] })).toBe("Bounce rate on example.com is 2.20%.");
  });

  it("names the domains when the organization has no finding of its own", () => {
    const domain = (name: string) => ({ name, standing: "watch" as const });
    expect(standingReason({ standing: "watch", findings: [], attention: [domain("a.example")] })).toBe("a.example needs a look.");
    expect(standingReason({ standing: "watch", findings: [], attention: [domain("a.example"), domain("b.example"), domain("c.example")] })).toBe(
      "a.example, b.example and c.example need a look.",
    );
  });
});
