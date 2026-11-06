import { describe, expect, it } from "vitest";
import { timelineEntry as entryIn } from "@/app/(app)/messages/message-detail-timeline";
import type { MessageTimelineEvent } from "@/lib/dashboard/views/messages";

const timelineEntry = (event: Parameters<typeof entryIn>[0]) => entryIn(event, "UTC");

const AT = new Date("2026-09-08T14:32:07.000Z");

function event(overrides: Partial<MessageTimelineEvent>): MessageTimelineEvent {
  return {
    id: "evt_1",
    kind: "transition",
    status: null,
    reason: null,
    detail: {},
    occurredAt: AT,
    ...overrides,
  };
}

describe("timelineEntry", () => {
  it("shows a transition as its lifecycle word", () => {
    const entry = timelineEntry(event({ kind: "transition", status: "delivered" }));

    expect(entry).toEqual({ marker: "14:32:07", title: "delivered", description: undefined });
  });

  it("names the sender on the send, and only there", () => {
    expect(entryIn(event({ kind: "transition", status: "sent" }), "UTC", "ada@example.com").description).toBe("From ada@example.com.");
    expect(entryIn(event({ kind: "transition", status: "delivered" }), "UTC", "ada@example.com").description).toBeUndefined();
  });

  it("names who a delivery was to, so one per recipient doesn't read as a repeat", () => {
    const entry = timelineEntry(
      event({ kind: "transition", status: "delivered", detail: { recipients: ["joey@example.com"] } }),
    );

    expect(entry).toEqual({ marker: "14:32:07", title: "delivered", description: "To joey@example.com." });
  });

  it("names the attempt, quotes the provider and says when the next one is due", () => {
    const entry = timelineEntry(
      event({
        kind: "retry",
        reason: "Temporary failure, try again",
        detail: { attempt: 2, nextAttemptAt: "2026-09-08T14:35:12.000Z" },
      }),
    );

    expect(entry.title).toBe("attempt 2 failed");
    expect(entry.description).toBe(
      "Provider rejected the message: Temporary failure, try again. Next attempt 14:35:12.",
    );
  });

  it("says when sending resumes, and how many times the message was held", () => {
    const entry = timelineEntry(
      event({
        kind: "backoff",
        reason: "You are sending emails too quickly",
        detail: { until: "2026-09-08T15:02:07.000Z", count: 3 },
      }),
    );

    expect(entry.title).toBe("backing off");
    expect(entry.description).toBe(
      "The provider asked for a pause: You are sending emails too quickly. Sending resumes 15:02:07. Held 3 times.",
    );
  });

  it("leaves the count out of a backoff that only happened once", () => {
    const entry = timelineEntry(
      event({ kind: "backoff", reason: "Slow down", detail: { until: "2026-09-08T15:02:07.000Z", count: 1 } }),
    );

    expect(entry.description).toBe("The provider asked for a pause: Slow down. Sending resumes 15:02:07.");
  });

  it("names the suppressed address and what it means", () => {
    const entry = timelineEntry(
      event({ kind: "suppressed", detail: { address: "gone@example.net", suppressionReason: "hard_bounce" } }),
    );

    expect(entry.title).toBe("address suppressed");
    expect(entry.description).toBe("Hard bounce on gone@example.net. Sends to it fail until you remove it.");
  });

  it("words a complaint as a complaint", () => {
    const entry = timelineEntry(
      event({ kind: "suppressed", detail: { address: "angry@example.net", suppressionReason: "complaint" } }),
    );

    expect(entry.description).toBe("Complaint from angry@example.net. Sends to it fail until you remove it.");
  });

  it("says which retention window shredded the body", () => {
    const entry = timelineEntry(event({ kind: "body_shredded", detail: { retentionDays: 45 } }));

    expect(entry.title).toBe("body shredded");
    expect(entry.description).toBe("Past the 45-day retention window. The delivery record stays.");
  });

  it("says the confirmation never arrived without calling it a failure", () => {
    const entry = timelineEntry(event({ kind: "abandoned", detail: { thresholdMs: 86_400_000 } }));

    expect(entry.title).toBe("no delivery confirmation");
    expect(entry.description).toBe("The provider accepted it and never reported back. It says nothing about whether it landed.");
  });

  it("shows a webhook delivery as its host and code", () => {
    const entry = timelineEntry(
      event({
        kind: "webhook_delivered",
        detail: { eventType: "email.delivered", url: "https://hooks.example.net/pouch", statusCode: 200 },
      }),
    );

    expect(entry.title).toBe("webhook delivered");
    expect(entry.description).toBe("email.delivered to hooks.example.net, 200.");
  });

  it("says what it can when a row is missing its detail", () => {
    const entry = timelineEntry(event({ kind: "retry", reason: null, detail: {} }));

    expect(entry.title).toBe("attempt 1 failed");
    expect(entry.description).toBeUndefined();
  });
});
