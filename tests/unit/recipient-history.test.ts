import { describe, expect, it } from "vitest";
import { evaluateHistory, HISTORY_BOUNCE_COUNT, HISTORY_DEFERRAL_COUNT } from "@/lib/messages/history";
import type { RecipientHistoryRow } from "@/lib/db/schema";

const DAY = 24 * 60 * 60 * 1000;

function row(overrides: Partial<RecipientHistoryRow> = {}): RecipientHistoryRow {
  return {
    organizationId: "org_1",
    address: "sam@example.com",
    firstSeenAt: new Date("2026-01-01"),
    lastDeliveredAt: null,
    lastBouncedAt: null,
    bounceCount: 0,
    lastComplainedAt: null,
    complaintCount: 0,
    lastDeferredAt: null,
    deferredCount: 0,
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("thresholds", () => {
  it("bounces once, nothing delivered since, earns the warning", () => {
    expect(HISTORY_BOUNCE_COUNT).toBe(1);
  });

  it("deferrals stay at 3 since the last delivery", () => {
    expect(HISTORY_DEFERRAL_COUNT).toBe(3);
  });
});

describe("a clean address", () => {
  it("never warns with no bad history", () => {
    expect(evaluateHistory(row())).toBeNull();
  });

  it("stays quiet on a single bounce that later delivered", () => {
    const bouncedAt = new Date("2026-01-01");
    const deliveredAt = new Date(bouncedAt.getTime() + DAY);
    expect(evaluateHistory(row({ bounceCount: 1, lastBouncedAt: bouncedAt, lastDeliveredAt: deliveredAt }))).toBeNull();
  });
});

describe("previously_bounced", () => {
  it("warns on one bounce with nothing delivered since", () => {
    const lastBouncedAt = new Date("2026-03-01");
    const verdict = evaluateHistory(row({ bounceCount: 1, lastBouncedAt }));
    expect(verdict?.code).toBe("previously_bounced");
    expect(verdict?.detail).toMatchObject({ bounce_count: 1 });
  });

  it("reads singular at one bounce", () => {
    const lastBouncedAt = new Date("2026-03-01");
    const verdict = evaluateHistory(row({ bounceCount: 1, lastBouncedAt }));
    expect(verdict?.message).toBe("Recipient bounced 1 time, most recently on 2026-03-01.");
  });

  it("reads plural at more than one bounce", () => {
    const lastBouncedAt = new Date("2026-03-01");
    const verdict = evaluateHistory(row({ bounceCount: 2, lastBouncedAt }));
    expect(verdict?.message).toBe("Recipient bounced 2 times, most recently on 2026-03-01.");
  });

  it("stays quiet at zero bounces", () => {
    const lastBouncedAt = new Date("2026-03-01");
    expect(evaluateHistory(row({ bounceCount: 0, lastBouncedAt }))).toBeNull();
  });

  it("stays quiet once a later delivery supersedes the bounce run", () => {
    const lastBouncedAt = new Date("2026-01-01");
    const lastDeliveredAt = new Date("2026-02-01");
    expect(evaluateHistory(row({ bounceCount: 4, lastBouncedAt, lastDeliveredAt }))).toBeNull();
  });

  it("warns again once a bounce happens after the recovery", () => {
    const lastDeliveredAt = new Date("2026-01-01");
    const lastBouncedAt = new Date("2026-02-01");
    const verdict = evaluateHistory(row({ bounceCount: 1, lastBouncedAt, lastDeliveredAt }));
    expect(verdict?.code).toBe("previously_bounced");
  });
});

describe("previously_complained", () => {
  it("warns on any complaint that hasn't been superseded by a later delivery", () => {
    const lastComplainedAt = new Date("2026-01-01");
    const verdict = evaluateHistory(row({ complaintCount: 1, lastComplainedAt }));
    expect(verdict?.code).toBe("previously_complained");
  });

  it("is checked ahead of a bounce warning, the worse signal first", () => {
    const at = new Date("2026-01-01");
    const verdict = evaluateHistory(row({ complaintCount: 1, lastComplainedAt: at, bounceCount: 1, lastBouncedAt: at }));
    expect(verdict?.code).toBe("previously_complained");
  });

  it("stays quiet once delivery happens after the complaint", () => {
    const lastComplainedAt = new Date("2026-01-01");
    const lastDeliveredAt = new Date("2026-02-01");
    expect(evaluateHistory(row({ complaintCount: 1, lastComplainedAt, lastDeliveredAt }))).toBeNull();
  });
});

describe("frequent_deferrals", () => {
  it("warns at 3 deferrals since the last delivery", () => {
    const lastDeferredAt = new Date("2026-01-01");
    const verdict = evaluateHistory(row({ deferredCount: 3, lastDeferredAt }));
    expect(verdict?.code).toBe("frequent_deferrals");
  });

  it("reads plural at threshold", () => {
    const lastDeferredAt = new Date("2026-01-01");
    const verdict = evaluateHistory(row({ deferredCount: 3, lastDeferredAt }));
    expect(verdict?.message).toBe("Sends to this recipient deferred 3 times, most recently on 2026-01-01.");
  });

  it("stays quiet at 2 deferrals", () => {
    const lastDeferredAt = new Date("2026-01-01");
    expect(evaluateHistory(row({ deferredCount: 2, lastDeferredAt }))).toBeNull();
  });

  it("stays quiet once a later delivery resolves the run", () => {
    const lastDeferredAt = new Date("2026-01-01");
    const lastDeliveredAt = new Date("2026-02-01");
    expect(evaluateHistory(row({ deferredCount: 5, lastDeferredAt, lastDeliveredAt }))).toBeNull();
  });
});
