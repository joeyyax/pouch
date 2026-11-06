/** Writes the OpenAPI document the docs site renders: `tsx scripts/gen-openapi.ts <out>`. */
import { writeFileSync } from "node:fs";
import { openApiDocument } from "@/lib/api-docs/openapi";

const out = process.argv[2] ?? "docs-site/openapi.json";
writeFileSync(out, `${JSON.stringify(openApiDocument(), null, 2)}\n`);
console.log(`openapi: wrote ${out}`);
