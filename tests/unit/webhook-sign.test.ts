import { describe, expect, it } from "vitest";
import { sign, signedString } from "@/lib/webhooks/sign";

describe("sign", () => {
  // Computed independently: printf '%s' '1700000000.{"id":"evt_test","type":"email.delivered"}' \
  //   | openssl dgst -sha256 -hmac 'whsec_test_secret' -hex
  it("matches a known-good HMAC-SHA256 over timestamp.body", () => {
    const secret = "whsec_test_secret";
    const timestamp = 1700000000;
    const body = '{"id":"evt_test","type":"email.delivered"}';

    expect(sign(secret, timestamp, body)).toBe(
      "sha256=db081b33a3e1bef3b714c0e11cc5780aa321a2c9bf00b68b48abacf2e7b7d6de",
    );
  });

  it("signs timestamp and body joined by a dot, so the receiver reconstructs the same string", () => {
    expect(signedString(1700000000, "hi")).toBe("1700000000.hi");
  });

  it("changes when the body changes", () => {
    const secret = "whsec_test_secret";
    const a = sign(secret, 1700000000, "one");
    const b = sign(secret, 1700000000, "two");
    expect(a).not.toBe(b);
  });

  it("changes when the timestamp changes", () => {
    const secret = "whsec_test_secret";
    const a = sign(secret, 1700000000, "same");
    const b = sign(secret, 1700000001, "same");
    expect(a).not.toBe(b);
  });
});
