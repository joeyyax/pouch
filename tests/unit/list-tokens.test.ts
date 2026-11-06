import { beforeEach, describe, expect, it } from "vitest";
import { signSubjectToken, verifySubjectToken } from "@/lib/lists/tokens";

describe("signSubjectToken / verifySubjectToken", () => {
  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = "test-secret-value";
  });

  it("round-trips the subject id for the purpose it was signed with", () => {
    const token = signSubjectToken("lmb_abc123", "unsubscribe");
    expect(verifySubjectToken(token, "unsubscribe")).toBe("lmb_abc123");
  });

  it("never puts the subject in a base64'd, reversible form beyond its own id", () => {
    // The token is exactly "<id>.<signature>" — nothing else is encoded into it.
    const token = signSubjectToken("lmb_abc123", "confirm");
    expect(token.startsWith("lmb_abc123.")).toBe(true);
  });

  it("rejects a token signed for a different purpose", () => {
    const token = signSubjectToken("lmb_abc123", "confirm");
    expect(verifySubjectToken(token, "unsubscribe")).toBeNull();
  });

  it("rejects a forged signature", () => {
    const token = signSubjectToken("lmb_abc123", "unsubscribe");
    const [id] = token.split(".");
    expect(verifySubjectToken(`${id}.forged-signature`, "unsubscribe")).toBeNull();
  });

  it("rejects a malformed token", () => {
    expect(verifySubjectToken("not-a-token", "unsubscribe")).toBeNull();
    expect(verifySubjectToken("", "unsubscribe")).toBeNull();
  });

  it("rejects a token signed under a different secret", () => {
    const token = signSubjectToken("lmb_abc123", "unsubscribe");
    process.env.BETTER_AUTH_SECRET = "a-different-secret";
    expect(verifySubjectToken(token, "unsubscribe")).toBeNull();
  });
});
