import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { encryptWith } from "@/lib/crypto";
import { failed } from "@/lib/dashboard/action-state";
import { decryptCredentials } from "@/lib/providers";
import type { ProviderRow } from "@/lib/providers";
import { CredentialsUnreadableError } from "@/lib/providers/unreadable";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

function rowWrittenUnder(key: Buffer): ProviderRow {
  return { name: "primary", credentials: encryptWith(key, "{}") } as ProviderRow;
}

describe("credentials written under another ENCRYPTION_KEY", () => {
  it("throws an error naming the provider", () => {
    expect(() => decryptCredentials(rowWrittenUnder(randomBytes(32)))).toThrow(CredentialsUnreadableError);
    expect(() => decryptCredentials(rowWrittenUnder(randomBytes(32)))).toThrow(/primary/);
  });

  it("reads back under the current key", () => {
    expect(decryptCredentials(rowWrittenUnder(Buffer.from(process.env.ENCRYPTION_KEY!, "base64")))).toEqual({});
  });

  it("names the cause in the dashboard's error, after what failed", () => {
    const state = failed(new CredentialsUnreadableError("primary"), "example.com couldn't be added.");
    expect(state).toEqual({
      status: "error",
      message:
        "example.com couldn't be added. Provider primary's credentials can't be decrypted with this install's ENCRYPTION_KEY. An admin re-enters them in Admin settings, Providers.",
    });
  });
});
