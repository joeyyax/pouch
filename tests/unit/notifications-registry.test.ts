import { describe, expect, it } from "vitest";
import { NOTIFICATION_TYPES, NOTIFICATIONS, notificationSetting } from "@/lib/notifications/registry";
import { OBSERVATION_NOTIFICATIONS } from "@/lib/notifications/observations";
import { OBSERVATIONS } from "@/lib/observations/registry.generated";
import { ALL_SETTINGS, settingDef } from "@/lib/settings/registry";

describe("the notification registry", () => {
  it("gives every type an operator switch in the Notifications section, on by default", () => {
    for (const type of NOTIFICATION_TYPES) {
      const def = settingDef(notificationSetting(type));
      expect(def, type).toMatchObject({ type: "boolean", section: "notifications", default: true });
      expect(NOTIFICATIONS[type].default, type).toBe(true);
    }
  });

  it("has no switch in the Notifications section without a type", () => {
    const switches = ALL_SETTINGS.filter((key) => settingDef(key).section === "notifications" && settingDef(key).type === "boolean");
    expect(switches.sort()).toEqual(NOTIFICATION_TYPES.map(notificationSetting).sort());
  });

  it("emails exactly the observations that define a notice", () => {
    const noticed = OBSERVATIONS.filter((observation) => observation.notice).map((observation) => observation.key);
    expect([...OBSERVATION_NOTIFICATIONS].sort()).toEqual(noticed.sort());
  });

  it("words each observation's notice without the address it's about", () => {
    for (const observation of OBSERVATIONS) {
      const notice = observation.notice?.(observation.example);
      if (!notice) continue;
      expect(notice.about.length, observation.key).toBeGreaterThan(0);
      expect(JSON.stringify(notice), observation.key).not.toContain("@");
    }
  });
});
