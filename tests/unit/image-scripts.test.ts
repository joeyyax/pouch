import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdown(path);
    return name.endsWith(".md") ? [path] : [];
  });
}

/** Scripts the docs tell an operator to run inside the container. */
function documentedScripts(): string[] {
  const found = new Set<string>();
  for (const file of [...markdown(join(ROOT, "docs")), join(ROOT, "README.md")]) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/node --import tsx (scripts\/[\w-]+\.ts)/g)) found.add(match[1]!);
  }
  return [...found].sort();
}

/** Scripts the Dockerfile copies into the runtime image. */
function shippedScripts(): Set<string> {
  const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
  return new Set([...dockerfile.matchAll(/\/app\/(scripts\/[\w-]+\.ts)/g)].map((match) => match[1]!));
}

describe("runtime image scripts", () => {
  it("finds documented scripts to check", () => {
    expect(documentedScripts().length).toBeGreaterThan(0);
  });

  it.each(documentedScripts())("ships %s", (script) => {
    expect(shippedScripts().has(script)).toBe(true);
  });
});
