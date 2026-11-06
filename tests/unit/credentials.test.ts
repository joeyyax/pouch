import { describe, expect, it } from "vitest";
import { parseCredentials } from "@/lib/providers/credentials";

describe("parseCredentials", () => {
  it("takes the credentials an adapter declares", () => {
    expect(parseCredentials("mailpace", '{"serverToken":"token"}')).toEqual({ serverToken: "token" });
  });

  it("names the field an adapter is missing", () => {
    expect(() => parseCredentials("ses", '{"accessKeyId":"AKIA"}')).toThrow(/secretAccessKey/);
  });

  it("refuses input that isn't JSON, rather than storing it as a token", () => {
    expect(() => parseCredentials("mailpace", "serverToken=token")).toThrow(/JSON/);
  });

  it("refuses an adapter it doesn't have", () => {
    expect(() => parseCredentials("carrier-pigeon", "{}")).toThrow(/carrier-pigeon/);
  });

  it("drops fields the adapter doesn't declare, so a typo can't be stored as a secret", () => {
    expect(parseCredentials("mailpace", '{"serverToken":"token","serverTokn":"typo"}')).toEqual({
      serverToken: "token",
    });
  });
});
