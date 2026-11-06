import { describe, expect, it } from "vitest";
import { buildFeedbackId, withFeedbackId } from "@/lib/messages/feedback-id";

describe("buildFeedbackId", () => {
  it.each([
    ["transactional", "org_123:transactional:pouch"],
    ["bulk", "org_123:bulk:pouch"],
  ] as const)("orders fields as organization, mail type, sender id for %s", (mailType, expected) => {
    expect(buildFeedbackId("org_123", mailType)).toBe(expected);
  });

  it("keeps the sender id within Google's 5-15 character range", () => {
    const senderId = buildFeedbackId("org_1", "bulk").split(":").pop()!;
    expect(senderId.length).toBeGreaterThanOrEqual(5);
    expect(senderId.length).toBeLessThanOrEqual(15);
  });
});

describe("withFeedbackId", () => {
  it("adds the header when none is present", () => {
    const headers = withFeedbackId({}, "org_123", "transactional", true);
    expect(headers["Feedback-ID"]).toBe("org_123:transactional:pouch");
  });

  it("never overwrites a caller-supplied header, case-insensitively", () => {
    const headers = withFeedbackId({ "feedback-id": "caller:set:value" }, "org_123", "transactional", true);
    expect(headers).toEqual({ "feedback-id": "caller:set:value" });
  });

  it("skips providers that drop custom headers", () => {
    const headers = withFeedbackId({}, "org_123", "transactional", false);
    expect(headers).toEqual({});
  });
});
