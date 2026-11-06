import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OBSERVATIONS } from "@/lib/observations/registry.generated";
import { observationFiles, registryPath, renderRegistry } from "@/scripts/gen-observations.mjs";

describe("observation registry", () => {
  it("matches the files in lib/observations", () => {
    expect(readFileSync(registryPath, "utf8")).toBe(renderRegistry());
  });

  it("registers every file and skips the _ files and the generated one", () => {
    const names = ["_types.ts", "_runner.ts", "registry.generated.ts", "tag-quiet.ts", "account-targeted.ts"];
    expect(observationFiles(names)).toEqual(["account-targeted.ts", "tag-quiet.ts"]);
  });

  it("has at least one observation, each with a unique key", () => {
    const keys = OBSERVATIONS.map((observation) => observation.key);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each(OBSERVATIONS.map((observation) => [observation.key, observation] as const))("%s has a name and a description", (_, observation) => {
    expect(observation.title.trim()).not.toBe("");
    expect(observation.description.trim()).not.toBe("");
  });

  it("offers tag or key mutes on every observation about sends", () => {
    // domain_spoofed is about mail the organization didn't send, so it has no tag or key; it can only be turned off.
    const unmutable = OBSERVATIONS.filter((observation) => observation.mutableBy.length === 0).map((observation) => observation.key);
    expect(unmutable).toEqual(["domain_spoofed"]);
  });

  it.each(OBSERVATIONS.map((observation) => [observation.key, observation] as const))("%s words its example for the overview and the digest", (_, observation) => {
    const wording = observation.condition(observation.example);
    expect(wording.title.trim()).not.toBe("");
    expect(wording.body.trim()).not.toBe("");
    for (const link of wording.links) expect(link.href.startsWith("/")).toBe(true);

    const line = observation.digestLine(observation.example);
    expect(line.text.trim()).not.toBe("");
    expect(line.path.startsWith("/")).toBe(true);
  });
});
