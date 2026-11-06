import { describe, expect, it } from "vitest";
import { sectionLabel, shouldAnnounce, topLevelSection } from "@/components/ui/route-announcer";

describe("topLevelSection", () => {
  it("treats a detail route as the same section as its list", () => {
    expect(topLevelSection("/messages/abc123")).toBe("/messages");
    expect(topLevelSection("/messages")).toBe("/messages");
  });

  it("names different top-level sections differently", () => {
    expect(topLevelSection("/domains")).not.toBe(topLevelSection("/messages"));
  });
});

describe("shouldAnnounce", () => {
  it("stays quiet on the first load — nothing has navigated yet", () => {
    expect(shouldAnnounce(null, "/messages")).toBe(false);
  });

  it("stays quiet within a section, so it never fights a detail panel's own focus restore", () => {
    expect(shouldAnnounce("/messages", "/messages")).toBe(false);
  });

  it("announces when the section actually changes", () => {
    expect(shouldAnnounce("/messages", "/domains")).toBe(true);
  });
});

describe("sectionLabel", () => {
  const nav = [
    { href: "/messages", label: "Messages" },
    { href: "/domains", label: "Domains" },
  ];

  it("uses the nav label for a listed section", () => {
    expect(sectionLabel("/domains", nav, "fallback")).toBe("Domains");
  });

  it("falls back for a route with no nav entry", () => {
    expect(sectionLabel("/keys/abc123", nav, "fallback")).toBe("fallback");
  });
});
