import { describe, expect, it } from "vitest";
import { createProviderSchema, listProvidersSchema, patchProviderSchema } from "@/lib/schemas/provider";

describe("createProviderSchema", () => {
  it("accepts a known adapter with a name and credentials", () => {
    const result = createProviderSchema.parse({ adapter: "mock", name: "primary", credentials: {} });
    expect(result).toMatchObject({ adapter: "mock", name: "primary", concurrency: 16 });
  });

  it("rejects an unknown adapter", () => {
    expect(() => createProviderSchema.parse({ adapter: "carrier-pigeon", name: "x", credentials: {} })).toThrow();
  });

  it("rejects a blank name", () => {
    expect(() => createProviderSchema.parse({ adapter: "mock", name: "", credentials: {} })).toThrow();
  });

  it("rejects a concurrency below 1", () => {
    expect(() => createProviderSchema.parse({ adapter: "mock", name: "x", credentials: {}, concurrency: 0 })).toThrow();
  });
});

describe("patchProviderSchema", () => {
  it("rejects an empty patch", () => {
    expect(() => patchProviderSchema.parse({})).toThrow();
  });

  it("accepts a name-only patch", () => {
    expect(patchProviderSchema.parse({ name: "renamed" })).toEqual({ name: "renamed" });
  });

  it("accepts a credentials-only patch", () => {
    expect(patchProviderSchema.parse({ credentials: { serverToken: "t" } })).toEqual({
      credentials: { serverToken: "t" },
    });
  });
});

describe("listProvidersSchema", () => {
  it("defaults the limit and leaves cursor unset", () => {
    expect(listProvidersSchema.parse({})).toEqual({ limit: 50 });
  });

  it("rejects a limit over 200", () => {
    expect(() => listProvidersSchema.parse({ limit: "201" })).toThrow();
  });
});
