/**
 * Converts a legacy provider into a tenant of a shared provider, keeping its id.
 *
 *   pnpm tsx scripts/convert-provider.ts <provider id> [--dry-run]
 *
 * A rerun resumes where a failed run stopped.
 */
import "@/lib/env";
import { workerActor } from "@/lib/activity/record";
import { ConversionStoppedError, MissingPermissionsError, convertToTenant } from "@/lib/providers/convert";
import { closeDb } from "@/lib/db";
import { closeRedis } from "@/lib/redis";

export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const [id] = argv.filter((arg) => !arg.startsWith("--"));
  if (!id) {
    log("usage: pnpm tsx scripts/convert-provider.ts <provider id> [--dry-run]");
    return 2;
  }
  try {
    const result = await convertToTenant(id, { actor: workerActor("convert-provider"), dryRun, log });
    if (!dryRun) log(result.converted ? `converted ${id} into tenant ${result.plan.tenantName} of ${result.plan.parentId}` : `not converted`);
    return 0;
  } catch (err) {
    if (err instanceof MissingPermissionsError) {
      log("stopped before changing anything. Grant these permissions and run again:");
      for (const permission of err.missing) log(`  ${permission}`);
    } else if (err instanceof ConversionStoppedError) {
      log(`${err.message}`);
      log(`last finished stage: ${err.reached ?? "none"}. Run the same command again to resume.`);
    } else {
      log(err instanceof Error ? err.message : String(err));
    }
    return 1;
  }
}

if (process.argv[1]?.endsWith("convert-provider.ts")) {
  main(process.argv.slice(2)).then(async (code) => {
    await closeDb();
    await closeRedis();
    process.exit(code);
  });
}
