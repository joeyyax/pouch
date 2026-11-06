/**
 * Ingests received mail still in a provider's inbound bucket, for announcements SNS gave up on.
 *
 *   pnpm tsx scripts/replay-inbound.ts <provider id> <object key>...
 *
 * Keys look like `inbound/<domain id>/<SES message id>`. A message already stored is a duplicate,
 * so a replay is safe to repeat.
 */
import "@/lib/env";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/lib/db";
import { providers } from "@/lib/db/schema";
import { receiveProviderMail } from "@/lib/inbound/ingest";
import { adapterFor } from "@/lib/providers";
import { closeRedis } from "@/lib/redis";
import { closeStorage } from "@/lib/storage";

export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  const [providerId, ...keys] = argv;
  if (!providerId || keys.length === 0) {
    log("usage: pnpm tsx scripts/replay-inbound.ts <provider id> <object key>...");
    return 2;
  }

  const [provider] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
  if (!provider) {
    log(`no provider ${providerId}`);
    return 1;
  }
  const stored = adapterFor(provider).inbound?.stored;
  if (!stored) {
    log(`${provider.adapter} has no stored inbound mail to replay`);
    return 1;
  }

  let failed = 0;
  for (const key of keys) {
    const mail = stored(key);
    if (!mail) {
      log(`${key}: not an inbound key`);
      failed += 1;
      continue;
    }
    try {
      const result = await receiveProviderMail(provider.id, mail);
      log(`${key}: ${result.accepted} accepted, ${result.duplicates} duplicate`);
    } catch (err) {
      log(`${key}: ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }
  return failed > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith("replay-inbound.ts")) {
  main(process.argv.slice(2)).then(async (code) => {
    await closeDb();
    await closeRedis();
    await closeStorage();
    process.exit(code);
  });
}
