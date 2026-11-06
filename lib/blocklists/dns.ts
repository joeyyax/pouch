/** A-record lookups for blocklist zones, through the host's resolver. */
import { Resolver } from "node:dns/promises";

/** A records at `name`. Empty for NXDOMAIN or no data. Throws on anything else. */
export type BlocklistLookup = (name: string, timeoutMs: number) => Promise<string[]>;

const NEGATIVE = new Set(["ENOTFOUND", "ENODATA"]);

/** The host's resolver, not a public one: Spamhaus refuses queries relayed by public resolvers. */
export const systemLookup: BlocklistLookup = async (name, timeoutMs) => {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      resolver.cancel();
      reject(Object.assign(new Error(`DNS lookup for ${name} timed out`), { code: "ETIMEOUT" }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([resolver.resolve4(name), timeout]);
  } catch (err) {
    if (NEGATIVE.has((err as NodeJS.ErrnoException).code ?? "")) return [];
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

let current: BlocklistLookup = systemLookup;

export function blocklistLookup(): BlocklistLookup {
  return current;
}

/** Tests only. Pass nothing to restore the system resolver. */
export function setBlocklistLookup(lookup?: BlocklistLookup): void {
  current = lookup ?? systemLookup;
}
