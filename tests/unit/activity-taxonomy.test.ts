import { describe, expect, it } from "vitest";
import { familyFor, isActivityAction, outcomeFor, phraseFor } from "@/lib/activity/taxonomy";
import {
  clearFilters,
  filtersToQuery,
  parseFilters,
  toggleFamily,
  toggleOutcome,
} from "@/lib/activity/filter";
import { groupActivity, isOrganizationWide } from "@/lib/activity/group";
import type { ActivityListItem } from "@/lib/activity/types";

describe("taxonomy", () => {
  it("classifies a known action's family and outcome", () => {
    expect(familyFor("key.revoked")).toBe("key");
    expect(outcomeFor("key.revoked")).toBe("success");
    expect(familyFor("session.sign_in.failed")).toBe("session");
    expect(outcomeFor("session.sign_in.failed")).toBe("failure");
  });

  it("falls back to system/neutral for an action it doesn't recognize", () => {
    expect(isActivityAction("made.up.thing")).toBe(false);
    expect(familyFor("made.up.thing")).toBe("system");
    expect(outcomeFor("made.up.thing")).toBe("neutral");
  });

  it("marks standalone actions so the sentence doesn't ask for a subject", () => {
    expect(phraseFor("system.retention.swept").standalone).toBe(true);
    expect(phraseFor("key.created").standalone).toBe(false);
  });
});

describe("filter round-trip", () => {
  it("parses what it serializes", () => {
    const filters = parseFilters({ family: "key,domain", outcome: "failure", actor: "user:u1" });
    const query = filtersToQuery(filters);
    expect(parseFilters(Object.fromEntries(new URLSearchParams(query)))).toEqual(filters);
  });

  it("toggles a family or outcome on and back off", () => {
    const empty = parseFilters({});
    const on = toggleFamily(empty, "key");
    expect(on.families).toEqual(["key"]);
    expect(toggleFamily(on, "key").families).toEqual([]);

    const withOutcome = toggleOutcome(empty, "failure");
    expect(withOutcome.outcomes).toEqual(["failure"]);
  });

  it("rejects a future `since`", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const future = new Date("2026-01-02T00:00:00Z").toISOString();
    expect(parseFilters({ since: future }, now).since).toBeNull();
  });

  it("clears families and outcomes but nothing else is tracked to clear", () => {
    const filters = toggleOutcome(toggleFamily(parseFilters({}), "key"), "failure");
    expect(clearFilters(filters)).toEqual({ families: [], outcomes: [], actors: [], since: null });
  });
});

function item(overrides: Partial<ActivityListItem> = {}): ActivityListItem {
  return {
    id: "act_1",
    action: "key.created",
    family: "key",
    outcome: "success",
    actor: { type: "user", id: "u1", label: "Ada" },
    appliesTo: "key_1",
    subjectLabel: "prod",
    subjectHref: "/keys/key_1",
    address: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("grouping", () => {
  it("collapses adjacent rows sharing an action, actor and outcome", () => {
    const rows = [
      item({ id: "act_3", createdAt: new Date("2026-01-01T00:02:00Z") }),
      item({ id: "act_2", createdAt: new Date("2026-01-01T00:01:00Z") }),
      item({ id: "act_1", createdAt: new Date("2026-01-01T00:00:00Z") }),
    ];
    const groups = groupActivity(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(3);
  });

  it("keeps a different outcome out of the run even when the action and actor match", () => {
    const rows = [
      item({ id: "act_2", outcome: "failure", createdAt: new Date("2026-01-01T00:01:00Z") }),
      item({ id: "act_1", createdAt: new Date("2026-01-01T00:00:00Z") }),
    ];
    expect(groupActivity(rows)).toHaveLength(2);
  });

  it("splits a run once the gap between rows is too wide", () => {
    const rows = [
      item({ id: "act_2", createdAt: new Date("2026-01-01T01:00:00Z") }),
      item({ id: "act_1", createdAt: new Date("2026-01-01T00:00:00Z") }),
    ];
    expect(groupActivity(rows)).toHaveLength(2);
  });

  it("treats a standalone, organization-wide action as fleet-wide with no named subject", () => {
    const group = groupActivity([
      item({ action: "system.retention.swept", family: "system", appliesTo: null, subjectLabel: null, subjectHref: null }),
    ])[0]!;
    expect(isOrganizationWide(group)).toBe(true);
  });

  it("treats a run over more than one subject as fleet-wide", () => {
    const rows = [
      item({ id: "act_2", appliesTo: "key_2", subjectLabel: "second", createdAt: new Date("2026-01-01T00:01:00Z") }),
      item({ id: "act_1", appliesTo: "key_1", subjectLabel: "first", createdAt: new Date("2026-01-01T00:00:00Z") }),
    ];
    const group = groupActivity(rows)[0]!;
    expect(group.subjects).toHaveLength(2);
    expect(isOrganizationWide(group)).toBe(true);
  });
});
