import { describe, expect, it } from "vitest";
import { detailsFor } from "@/lib/activity/labels";
import type { ActivityGroup } from "@/lib/activity/types";

function group(action: string, metadata: Record<string, unknown>): ActivityGroup {
  const at = new Date("2026-09-01T00:00:00Z");
  const actor = { type: "worker" as const, id: null, label: "Pouch" };
  return {
    id: "act_1",
    action,
    family: "system",
    outcome: "neutral",
    actor,
    subjects: [],
    count: 1,
    firstAt: at,
    lastAt: at,
    single: { id: "act_1", action, family: "system", outcome: "neutral", actor, appliesTo: null, subjectLabel: null, subjectHref: null, address: null, metadata, createdAt: at },
  };
}

describe("detailsFor", () => {
  it("counts bodies for a retention sweep and messages for an abandon sweep", () => {
    expect(detailsFor(group("system.retention.swept", { count: 3 }))).toEqual(["3 bodies"]);
    expect(detailsFor(group("system.abandon.swept", { count: 1 }))).toEqual(["1 message"]);
  });

  it("doesn't read a stall's bounce count as a number of bodies", () => {
    const details = detailsFor(group("domain.stalled", { reason: "bounce_count", count: 3, denominator: 12 }));
    expect(details.some((detail) => detail.includes("bodies"))).toBe(false);
  });
});
