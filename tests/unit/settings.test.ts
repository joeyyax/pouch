import { describe, expect, it } from "vitest";
import { parseSettings } from "@/lib/providers/credentials";

describe("parseSettings", () => {
  it("takes the settings an adapter declares", () => {
    expect(parseSettings("mailpace", '{"webhookPublicKey":"key"}')).toEqual({ webhookPublicKey: "key" });
  });

  it("takes a provider with no settings", () => {
    expect(parseSettings("ses", "")).toEqual({});
    expect(parseSettings("ses", "{}")).toEqual({});
  });

  it("refuses input that isn't JSON", () => {
    expect(() => parseSettings("mailpace", "webhookPublicKey=key")).toThrow(/JSON/);
  });

  it("refuses a nested value the column can't hold", () => {
    expect(() => parseSettings("mailpace", '{"webhookPublicKey":{"nested":true}}')).toThrow(/webhookPublicKey/);
  });

  it("drops a field the adapter doesn't declare", () => {
    expect(parseSettings("mailpace", '{"webhookPublicKey":"key","typo":"x"}')).toEqual({ webhookPublicKey: "key" });
  });
});
