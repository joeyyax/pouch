import { randomBytes } from "node:crypto";
import { checkoutTag } from "./database-url";

/**
 * This run's slice of the shared MinIO bucket. #81 gave each checkout its own test
 * database; storage stayed on one shared `bodies/` prefix, so a body written by any
 * other checkout or process during the run looked like an orphan to whichever run's
 * idempotency test happened to be listing at the time.
 *
 * Salted by process, not just checkout: two `vitest run` invocations in the same
 * checkout still share a test database (a known, unfixed friction), but storage
 * doesn't need to inherit that collision too.
 */
export function testStoragePrefix(): string {
  return `test-bodies/${checkoutTag()}-${processTag}`;
}

const processTag = randomBytes(4).toString("hex");
