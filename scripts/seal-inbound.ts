/** Seals inbound mail stored before #487. Usage: pnpm tsx scripts/seal-inbound.ts [--dry-run] [--batch <n>] [--concurrency <n>] */
import "@/lib/env";
import { closeDb } from "@/lib/db";
import { countLegacyInbound, countLegacyInboundDetail, sealLegacyInbound } from "@/lib/inbound/seal";
import { closeRedis } from "@/lib/redis";
import { closeStorage } from "@/lib/storage";

function flag(argv: string[], name: string): number | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = Number(argv[at + 1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function main(argv: string[], log: (line: string) => void = console.log): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const before = await countLegacyInbound();
  log(`${before} inbound message(s) hold plaintext`);
  if (dryRun) return 0;

  const started = Date.now();
  const result = await sealLegacyInbound({ batchSize: flag(argv, "--batch"), concurrency: flag(argv, "--concurrency"), log });
  const after = await countLegacyInboundDetail();
  log(
    `sealed ${result.sealed}, failed ${result.failed}, swept ${result.swept}, scrubbed ${result.payloadsScrubbed} payload(s) ` +
      `in ${Math.round((Date.now() - started) / 1000)}s. ${after.total} still hold plaintext, ${after.expired} of them past retention.`,
  );
  return result.failed > 0 ? 1 : 0;
}

if (process.argv[1]?.endsWith("seal-inbound.ts")) {
  main(process.argv.slice(2)).then(async (code) => {
    await closeDb();
    await closeRedis();
    await closeStorage();
    process.exit(code);
  });
}
