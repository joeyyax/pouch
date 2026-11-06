/** Alerts when organizations sharing one provider identity cross the stall thresholds together. */
import { evaluateStall, STALL_WINDOW_DAYS, type StallLines, type StallVerdict } from "@/lib/domains/guard";
import { readStallLines } from "@/lib/domains/stall";
import { listProviderIdentityRates } from "@/lib/system/read";
import type { ProviderIdentityGroupView } from "@/lib/system/views";
import { logger } from "@/lib/logger";
import { EMPTY_COUNTS, outcomeCounts } from "@/lib/metrics/rates";
import { sendProviderIdentityAtRiskAlert } from "@/lib/notifications/push/provider-identity-at-risk";
import { redis, scanKeys } from "@/lib/redis";
import { safeErrorMessage } from "@/lib/errors/scrub";

const log = logger.child("suspension:rollup");

const ALERT_KEY_PREFIX = "provider-identity-alert:";

/** One alert per identity and reason per window, so a lasting problem repeats weekly, not every tick. */
const ALERT_TTL_SECONDS = STALL_WINDOW_DAYS * 24 * 60 * 60;

const alertedInProcess = new Map<string, number>();

export interface RollupFinding {
  group: ProviderIdentityGroupView;
  verdict: StallVerdict;
}

/** Groups shared by two or more organizations whose summed counts cross the action point. */
export function rollupFindings(groups: ProviderIdentityGroupView[], lines: StallLines): RollupFinding[] {
  const findings: RollupFinding[] = [];
  for (const group of groups) {
    if (!group.identity || group.organizationNames.length < 2) continue;
    const verdict = evaluateStall({ counts: outcomeCounts(group), previousCounts: EMPTY_COUNTS, lines });
    if (verdict) findings.push({ group, verdict });
  }
  return findings;
}

async function claimAlert(key: string): Promise<boolean> {
  const client = redis();
  if (client) {
    try {
      return (await client.set(key, "1", "EX", ALERT_TTL_SECONDS, "NX")) === "OK";
    } catch (err) {
      log.warn(`alert dedupe unavailable, using this process's memory: ${safeErrorMessage(err)}`);
    }
  }
  const now = Date.now();
  const until = alertedInProcess.get(key);
  if (until && until > now) return false;
  alertedInProcess.set(key, now + ALERT_TTL_SECONDS * 1000);
  return true;
}

/** Returns how many alerts it sent. */
export async function checkProviderIdentityRollup(): Promise<number> {
  const [groups, lines] = await Promise.all([listProviderIdentityRates(), readStallLines()]);
  const findings = rollupFindings(groups, lines);
  let sent = 0;
  for (const { group, verdict } of findings) {
    if (!(await claimAlert(`${ALERT_KEY_PREFIX}${group.key}:${verdict.reason}`))) continue;
    try {
      await sendProviderIdentityAtRiskAlert(group, verdict);
      sent += 1;
    } catch (err) {
      log.warn(`couldn't send the rollup alert for ${group.key}: ${safeErrorMessage(err)}`);
    }
  }
  return sent;
}

/** Test hook: forgets every alert already sent. */
export async function resetRollupAlerts(): Promise<void> {
  alertedInProcess.clear();
  const client = redis();
  if (!client) return;
  const keys = await scanKeys(client, ALERT_KEY_PREFIX);
  if (keys.length > 0) await client.del(...keys);
}
