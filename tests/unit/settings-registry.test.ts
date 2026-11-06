import { describe, expect, it } from "vitest";
import type { LifecycleRule } from "@aws-sdk/client-s3";
import { bodyExpiryDays } from "@/lib/storage/lifecycle";
import { featureForPath } from "@/lib/features/registry";
import { ALL_SETTINGS, parseSettingValue, resolveSettings, SETTING_PAGES, SETTING_SECTIONS, settingDef, settingLocation, type SettingDef } from "@/lib/settings/registry";

describe("resolveSettings", () => {
  it("takes the environment, then the stored value, then the default, skipping what doesn't parse", () => {
    const states = resolveSettings({ FEATURE_INBOUND: "off", FEATURE_MCP: "maybe" }, { inbound: true, mcp: false, observations: "yes please" });
    expect(states.inbound).toMatchObject({ value: false, source: "env" });
    expect(states.mcp).toMatchObject({ value: false, source: "settings" });
    expect(states.observations).toMatchObject({ value: true, source: "default" });
  });

  it("makes a feature unavailable while the one it depends on is off", () => {
    const states = resolveSettings({}, { inbound: false });
    expect(states.addresses).toMatchObject({ value: true, available: false });
  });

  it("only depends on entries that are features", () => {
    for (const key of ALL_SETTINGS) {
      const dependency = settingDef(key).dependsOn;
      if (dependency) expect(settingDef(dependency as typeof key).type, key).toBe("boolean");
    }
  });
});

describe("parseSettingValue", () => {
  const days: SettingDef = { type: "integer", section: "sending", label: "Days", description: "", env: "DAYS", default: 30, min: 7, max: 90, unit: "days" };

  it.each([
    ["30", 30],
    [90, 90],
    [" 7 ", 7],
    ["6", undefined],
    [91, undefined],
    ["3.5", undefined],
    ["", undefined],
  ])("reads %j as %j for an integer from 7 to 90", (raw, value) => {
    expect(parseSettingValue(days, raw)).toBe(value);
  });
});

describe("parseSettingValue on a decimal", () => {
  const percent: SettingDef = { type: "decimal", section: "reputation", label: "Rate", description: "", env: "RATE", default: 2.5, min: 0.5, max: 2.5, step: 0.1, unit: "%" };

  it.each([
    ["2.5", 2.5],
    [1.3, 1.3],
    [" 0.5 ", 0.5],
    ["2.6", undefined],
    ["0.4", undefined],
    ["1.25", undefined],
    ["-1", undefined],
    ["", undefined],
  ])("reads %j as %j for 0.5 to 2.5 in steps of 0.1", (raw, value) => {
    expect(parseSettingValue(percent, raw)).toBe(value);
  });
});

describe("the reputation entries", () => {
  const reputation = ALL_SETTINGS.map((key) => settingDef(key)).filter((def) => def.section === "reputation");

  it("only tighten: each default is its highest value", () => {
    expect(reputation.length).toBeGreaterThan(0);
    for (const def of reputation) {
      if (def.type !== "integer" && def.type !== "decimal") throw new Error(`${def.label} isn't a number`);
      expect(def.max, def.label).toBe(def.default);
      expect(def.min, def.label).toBeGreaterThan(0);
    }
  });
});

describe("featureForPath", () => {
  it.each([
    ["/v1/lists", "lists"],
    ["/api/v1/lists/lst_1/members", "lists"],
    ["/v1/lists/lst_1/unsubscribe", null],
    ["/v1/batches/bat_1", "bulk"],
    ["/v1/domains/dom_1/inbound", "inbound"],
    ["/v1/domains/dom_1", null],
    ["/v1/addresses/adr_1/reply", "addresses"],
    ["/mcp", "mcp"],
    ["/v1/listsx", null],
  ])("%s belongs to %s", (path, feature) => {
    expect(featureForPath(path)).toBe(feature);
  });
});

describe("bodyExpiryDays", () => {
  const rule = (days: number, extra: Partial<LifecycleRule> = {}): LifecycleRule => ({ Status: "Enabled", Expiration: { Days: days }, ...extra });

  it("takes the soonest enabled rule that reaches body objects", () => {
    expect(
      bodyExpiryDays(
        [
          rule(500, { Filter: { Prefix: "" } }),
          rule(400, { Filter: { Prefix: "bodies/" } }),
          rule(30, { Filter: { Prefix: "inbound/" } }),
          rule(10, { Status: "Disabled", Filter: { Prefix: "bodies/" } }),
          rule(20, { Filter: { Tag: { Key: "tmp", Value: "1" } } }),
        ],
        "bodies",
      ),
    ).toBe(400);
  });

  it("counts a rule on part of the bodies prefix and the legacy Prefix field", () => {
    expect(bodyExpiryDays([rule(90, { Filter: { Prefix: "bodies/ab" } })], "bodies")).toBe(90);
    expect(bodyExpiryDays([rule(80, { Prefix: "bod" })], "bodies")).toBe(80);
    expect(bodyExpiryDays([rule(80, { Filter: { Prefix: "bodiesx/" } })], "bodies")).toBeNull();
  });
});

describe("admin settings tabs", () => {
  it("puts every section on a tab, and every tab holds one", () => {
    const pages = new Set(SETTING_PAGES.map((page) => page.id));
    for (const section of SETTING_SECTIONS) expect(pages.has(section.page)).toBe(true);
    for (const page of SETTING_PAGES) expect(SETTING_SECTIONS.some((section) => section.page === page.id)).toBe(true);
  });

  it("names the tab an entry is changed on", () => {
    expect(settingLocation("access")).toBe("Admin settings → Access");
    expect(settingLocation("monitoring")).toBe("Admin settings → Reputation");
  });
});
