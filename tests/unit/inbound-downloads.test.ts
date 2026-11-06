import { beforeEach, describe, expect, it } from "vitest";
import { inboundDownloadUrl, signInboundDownload, verifyInboundDownload } from "@/lib/inbound/downloads";

const NOW = new Date("2026-10-01T12:00:00Z");
const LATER = new Date(NOW.getTime() + 900_000);

describe("inbound download tokens", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-value";
  });

  it("round-trips an attachment index and the raw message", () => {
    expect(verifyInboundDownload(signInboundDownload("inb_abc", 2, LATER), NOW)).toEqual({ inboundId: "inb_abc", part: 2 });
    expect(verifyInboundDownload(signInboundDownload("inb_abc", "raw", LATER), NOW)).toEqual({ inboundId: "inb_abc", part: "raw" });
  });

  it("refuses an expired token", () => {
    expect(verifyInboundDownload(signInboundDownload("inb_abc", 0, LATER), new Date(LATER.getTime() + 1000))).toBeNull();
  });

  it("refuses a token pointed at another message or part", () => {
    const [, part, expiry, signature] = signInboundDownload("inb_abc", 0, LATER).split(".");
    expect(verifyInboundDownload(`inb_other.${part}.${expiry}.${signature}`, NOW)).toBeNull();
    expect(verifyInboundDownload(`inb_abc.raw.${expiry}.${signature}`, NOW)).toBeNull();
    expect(verifyInboundDownload(`inb_abc.${part}.${Number(expiry) + 3600}.${signature}`, NOW)).toBeNull();
  });

  it("refuses a token signed with another secret", () => {
    const token = signInboundDownload("inb_abc", 0, LATER);
    process.env.BETTER_AUTH_SECRET = "rotated";
    expect(verifyInboundDownload(token, NOW)).toBeNull();
  });

  it("links to the app, not to storage", () => {
    expect(inboundDownloadUrl("inb_abc", 0, 900, NOW)).toMatch(/\/download\/inb_abc\.0\.\d+\.[\w-]+$/);
  });
});
