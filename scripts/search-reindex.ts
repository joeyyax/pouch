/**
 * Fills the search index from Postgres. Safe to rerun: documents are upserted by id.
 *
 *   node --import tsx scripts/search-reindex.ts [--organization <id>] [--fresh]
 */
import "@/lib/env";
import { closeDb } from "@/lib/db";
import { searchProvider } from "@/lib/search";
import { reindex } from "@/lib/search/reindex";

export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  const provider = searchProvider();
  if (provider.mode === "postgres") {
    log("MEILISEARCH_URL isn't set, so there's no index to fill.");
    return 2;
  }
  const at = argv.indexOf("--organization");
  const organizationId = at >= 0 ? argv[at + 1] : undefined;
  try {
    const counts = await reindex(provider, { organizationId, fresh: argv.includes("--fresh"), log });
    log(`indexed ${counts.messages} messages and ${counts.suppressions} suppressions`);
    return 0;
  } catch (err) {
    log(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1]?.endsWith("search-reindex.ts")) {
  main(process.argv.slice(2)).then(async (code) => {
    await closeDb();
    process.exit(code);
  });
}
