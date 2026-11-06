import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, observationMutes } from "@/lib/db/schema";
import { safeErrorMessage } from "@/lib/errors/scrub";
import { isFeatureEnabled } from "@/lib/features";
import { logger } from "@/lib/logger";
import type { ConditionTone } from "@/lib/metrics/conditions";
import { contextFactory } from "./_context";
import type { Finding, MuteOffer, Observation, ObservationDigestLine, ObservationNotice, ObservationWording } from "./_types";
import { OBSERVATIONS } from "./registry.generated";

const log = logger.child("observations");

/** One finding, worded for both surfaces. */
export interface ObservationResult {
  key: string;
  tone: ConditionTone;
  wording: ObservationWording;
  digest: ObservationDigestLine;
  /** Null when the observation isn't emailed. */
  notice: ObservationNotice | null;
  mute: MuteOffer;
}

interface MuteSet {
  off: boolean;
  tags: Set<string>;
  keyIds: Set<string>;
}

/** Every mute row in the organization, by observation key. Rows for a key no file defines are never read. */
async function readMuteSets(organizationId: string): Promise<Map<string, MuteSet>> {
  const rows = await db
    .select({ key: observationMutes.key, tag: observationMutes.tag, apiKeyId: observationMutes.apiKeyId })
    .from(observationMutes)
    .where(eq(observationMutes.organizationId, organizationId));
  const sets = new Map<string, MuteSet>();
  for (const row of rows) {
    const set = sets.get(row.key) ?? { off: false, tags: new Set<string>(), keyIds: new Set<string>() };
    if (row.tag !== null) set.tags.add(row.tag);
    else if (row.apiKeyId !== null) set.keyIds.add(row.apiKeyId);
    else set.off = true;
    sets.set(row.key, set);
  }
  return sets;
}

function muted(finding: Finding, set: MuteSet | undefined): boolean {
  if (!set) return false;
  return finding.tags.some((tag) => set.tags.has(tag)) || finding.keyIds.some((id) => set.keyIds.has(id));
}

/**
 * Runs every observation that's on for the organization, drops findings a mute covers and words
 * the rest. One that throws is logged and left out, so it can't take the overview down. Nothing
 * runs while the observations feature is off.
 */
export async function runObservations(
  organizationId: string,
  now: Date,
  observations: readonly Observation[] = OBSERVATIONS,
): Promise<ObservationResult[]> {
  if (!(await isFeatureEnabled("observations"))) return [];
  const sets = await readMuteSets(organizationId);
  const contextFor = contextFactory(organizationId, now);

  const found = await Promise.all(
    observations.map(async (observation) => {
      const set = sets.get(observation.key);
      if (set?.off) return [];
      try {
        const findings = await observation.evaluate(contextFor({ tags: [...(set?.tags ?? [])], keyIds: [...(set?.keyIds ?? [])] }));
        return findings.filter((finding) => !muted(finding, set)).map((finding) => ({ observation, finding }));
      } catch (error) {
        log.error(`${observation.key} failed: ${safeErrorMessage(error)}`);
        return [];
      }
    }),
  );
  const pairs = found.flat();

  const keyIds = [...new Set(pairs.flatMap(({ observation, finding }) => (observation.mutableBy.includes("key") ? finding.keyIds : [])))];
  const names = new Map<string, string>();
  if (keyIds.length > 0) {
    const rows = await db
      .select({ id: apiKeys.id, name: apiKeys.name })
      .from(apiKeys)
      .where(and(eq(apiKeys.organizationId, organizationId), inArray(apiKeys.id, keyIds)));
    for (const row of rows) names.set(row.id, row.name);
  }

  return pairs.map(({ observation, finding }) => ({
    key: observation.key,
    tone: observation.tone,
    wording: observation.condition(finding),
    digest: observation.digestLine(finding),
    notice: observation.notice?.(finding) ?? null,
    mute: {
      observation: observation.key,
      title: observation.title,
      tags: observation.mutableBy.includes("tag") ? finding.tags : [],
      keys: observation.mutableBy.includes("key")
        ? finding.keyIds.flatMap((id) => (names.has(id) ? [{ id, name: names.get(id)! }] : []))
        : [],
    },
  }));
}
