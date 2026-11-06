import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decrypt, decryptBytesWith, decryptWith, encrypt, encryptWith, newMessageKey, sha256 } from "@/lib/crypto";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

describe("credential encryption", () => {
  it("round-trips a credentials payload", () => {
    const payload = JSON.stringify({ serverToken: "secret-token" });
    expect(decrypt(encrypt(payload))).toBe(payload);
  });

  it("produces different ciphertext for the same plaintext", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("keeps the plaintext out of the ciphertext", () => {
    expect(encrypt("secret-token")).not.toContain("secret-token");
  });

  it("refuses a tampered payload rather than returning garbage", () => {
    const parts = encrypt("secret").split(".");
    const flipped = Buffer.from(parts[3] ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[3] = flipped.toString("base64url");

    expect(() => decrypt(parts.join("."))).toThrow();
  });

  it("refuses a payload with an unknown version", () => {
    expect(() => decrypt(encrypt("secret").replace(/^v1/, "v9"))).toThrow(/malformed/);
  });

  it("refuses a key that is not 32 bytes", () => {
    const good = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = randomBytes(16).toString("base64");
    try {
      expect(() => encrypt("secret")).toThrow(/32 bytes/);
    } finally {
      process.env.ENCRYPTION_KEY = good;
    }
  });
});

describe("per-message key encryption", () => {
  it("round-trips with the key it was encrypted with", () => {
    const { key } = newMessageKey();
    const payload = JSON.stringify({ html: "<p>hi</p>", text: "hi", textGenerated: false, attachments: [] });
    expect(decryptWith(key, encryptWith(key, payload))).toBe(payload);
  });

  it("fails when decrypted with a different key", () => {
    const { key: a } = newMessageKey();
    const { key: b } = newMessageKey();
    const payload = "secret-body";
    const ciphertext = encryptWith(a, payload);

    expect(() => decryptWith(b, ciphertext)).toThrow();
  });

  it("refuses a tampered ciphertext even when the key is correct", () => {
    const { key } = newMessageKey();
    const parts = encryptWith(key, "secret").split(".");
    const flipped = Buffer.from(parts[3] ?? "", "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    parts[3] = flipped.toString("base64url");

    expect(() => decryptWith(key, parts.join("."))).toThrow();
  });

  it("newMessageKey returns 32 random bytes", () => {
    const { key, encoded } = newMessageKey();
    expect(key.length).toBe(32);
    expect(Buffer.from(encoded, "base64").length).toBe(32);
  });

  it("two calls produce different keys", () => {
    const a = newMessageKey();
    const b = newMessageKey();
    expect(a.encoded).not.toBe(b.encoded);
  });
});

describe("hashing", () => {
  it("is stable for the same input", () => {
    expect(sha256("sk_live_abc")).toBe(sha256("sk_live_abc"));
  });

  it("differs for different input", () => {
    expect(sha256("sk_live_abc")).not.toBe(sha256("sk_live_abd"));
  });
});
describe("byte encryption", () => {
  it("round-trips binary content, including none", () => {
    const { key } = newMessageKey();
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0a]);
    expect(decryptBytesWith(key, encryptWith(key, bytes)).equals(bytes)).toBe(true);
    expect(decryptBytesWith(key, encryptWith(key, Buffer.alloc(0))).length).toBe(0);
  });
});
