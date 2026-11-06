import { describe, expect, it } from "vitest";
import { domainOf, formatAddress, isEmailAddress, normalizeAddress, parseAddress } from "@/lib/addresses";

describe("normalizeAddress", () => {
  it.each([
    ["lowercases the domain part", "person@EXAMPLE.COM", "person@example.com"],
    ["preserves case in the local part", "First.Last@Example.com", "First.Last@example.com"],
    ["lowercases only past the last at sign", '"a@B"@EXAMPLE.NET', '"a@B"@example.net'],
    ["leaves a string with no at sign alone", "  not-an-address ", "not-an-address"],
  ])("%s", (_name, input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });
});

describe("parseAddress", () => {
  it("splits the display name from the address", () => {
    expect(parseAddress("Ada Lovelace <Ada@Example.COM>")).toEqual({
      name: "Ada Lovelace",
      address: "Ada@example.com",
    });
  });

  it("strips quotes around a display name", () => {
    expect(parseAddress('"Lovelace, Ada" <ada@example.com>')?.name).toBe("Lovelace, Ada");
  });

  it("returns a null name for a bare address", () => {
    expect(parseAddress("ada@example.com")).toEqual({ name: null, address: "ada@example.com" });
  });

  it("rejects an address with no domain", () => {
    expect(parseAddress("Ada <ada@>")).toBeNull();
  });

  it("rejects an address with a space in it", () => {
    expect(parseAddress("ada lovelace@example.com")).toBeNull();
  });
});

describe("domainOf", () => {
  it("returns the lowercased domain", () => {
    expect(domainOf("Person@Example.NET")).toBe("example.net");
  });
});

describe("formatAddress", () => {
  it("emits the angle form when a name is present", () => {
    expect(formatAddress({ name: "Ada", address: "ada@example.com" })).toBe("Ada <ada@example.com>");
  });

  it("emits a bare address when the name is null", () => {
    expect(formatAddress({ name: null, address: "ada@example.com" })).toBe("ada@example.com");
  });
});

describe("isEmailAddress", () => {
  it.each([
    ["rejects a domain with no dot", "ada@localhost", false],
    ["accepts a subdomain", "ada@mail.example.co.uk", true],
  ])("%s", (_name, input, expected) => {
    expect(isEmailAddress(input)).toBe(expected);
  });
});
