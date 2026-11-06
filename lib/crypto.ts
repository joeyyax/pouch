import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY isn't set. Generate one with: openssl rand -base64 32");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must decode to 32 bytes of base64.");
  return buf;
}

/** Encrypts to `v1.<iv>.<tag>.<ciphertext>`, all base64url. A string is taken as UTF-8. */
export function encryptWith(key: Buffer, plaintext: string | Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const input = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptBytesWith(key: Buffer, payload: string): Buffer {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("Encrypted payload is malformed.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]);
}

export function decryptWith(key: Buffer, payload: string): string {
  return decryptBytesWith(key, payload).toString("utf8");
}

/** Wrapper that uses the env key, so callers don't pass a Buffer in. */
export function encrypt(plaintext: string): string {
  return encryptWith(key(), plaintext);
}

export function decrypt(payload: string): string {
  return decryptWith(key(), payload);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 32 random bytes for a per-message encryption key, encoded as base64 for the row. */
export function newMessageKey(): { key: Buffer; encoded: string } {
  const buf = randomBytes(32);
  return { key: buf, encoded: buf.toString("base64") };
}