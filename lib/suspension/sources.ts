/** Which suspension sources hold queued mail. No server imports, so client screens can use it. */
import type { SuspensionSource } from "@/lib/db/schema/organizations";

/** Sources whose queued mail waits for a release instead of failing. See docs/decisions.md. */
export const HOLDING_SOURCES = ["reputation", "provider"] as const satisfies readonly SuspensionSource[];

export function holdsQueue(source: SuspensionSource): boolean {
  return (HOLDING_SOURCES as readonly SuspensionSource[]).includes(source);
}
