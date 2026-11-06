/**
 * The threshold behind the system screen's unconfirmed signal. What matters isn't the numbers
 * themselves but the two properties they buy: a low-volume install can't trip it, and a
 * high-volume one can't bury a real outage under its own send count.
 */
import { describe, expect, it } from "vitest";
import { UNCONFIRMED_CLUSTER_FLOOR, UNCONFIRMED_CLUSTER_SHARE, unconfirmedClustered } from "@/lib/system/views";

/** Sends that make `marked` come out at exactly `share`. */
function sendsFor(marked: number, share: number): number {
  return Math.floor(marked / share);
}

describe("unconfirmedClustered", () => {
  it("is quiet with nothing marked", () => {
    expect(unconfirmedClustered(0, 10_000)).toBe(false);
    expect(unconfirmedClustered(0, 0)).toBe(false);
  });

  it("stays quiet under the floor however bad the share looks", () => {
    const marked = UNCONFIRMED_CLUSTER_FLOOR - 1;
    // Every single send in the window went unconfirmed, and it's still too few to act on.
    expect(unconfirmedClustered(marked, marked)).toBe(false);
  });

  it("goes loud once the marks are both numerous and a real share of the window's sends", () => {
    const marked = UNCONFIRMED_CLUSTER_FLOOR;
    expect(unconfirmedClustered(marked, sendsFor(marked, UNCONFIRMED_CLUSTER_SHARE))).toBe(true);
  });

  it("stays quiet when the same count is a rounding error against the volume", () => {
    const marked = UNCONFIRMED_CLUSTER_FLOOR * 2;
    const sends = sendsFor(marked, UNCONFIRMED_CLUSTER_SHARE / 4);
    expect(unconfirmedClustered(marked, sends)).toBe(false);
  });

  it("scales with volume rather than tripping on a fixed count", () => {
    // The same share reads the same at two volumes an order of magnitude apart.
    const small = UNCONFIRMED_CLUSTER_FLOOR * 2;
    const large = small * 10;
    const share = UNCONFIRMED_CLUSTER_SHARE * 2;
    expect(unconfirmedClustered(small, sendsFor(small, share))).toBe(true);
    expect(unconfirmedClustered(large, sendsFor(large, share))).toBe(true);
  });

  it("goes loud with marks and no eligible sends to measure them against", () => {
    // Every mark came from a send, so nothing eligible means the sweep is running behind its own
    // window. That's not a reason to go quiet.
    expect(unconfirmedClustered(UNCONFIRMED_CLUSTER_FLOOR, 0)).toBe(true);
  });
});
