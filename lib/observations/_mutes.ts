import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, observationMutes } from "@/lib/db/schema";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import { newId } from "@/lib/ids";
import type { MuteKind, Observation } from "./_types";
import { OBSERVATIONS } from "./registry.generated";

/** A dashboard session acting on its organization. */
export interface ObservationCaller {
  organizationId: string;
  /** Domains the caller is limited to. Empty means every domain. */
  domainIds: string[];
  actor: ActivityActor;
  /** The user behind the actor, stored as `created_by`. */
  userId: string | null;
}

export interface MuteView {
  id: string;
  kind: MuteKind;
  /** The tag, or the key's name. */
  label: string;
  createdAt: Date;
}

export interface ObservationSetting {
  key: string;
  title: string;
  description: string;
  on: boolean;
  mutableBy: readonly MuteKind[];
  mutes: MuteView[];
}

export type MuteTarget = { tag: string } | { keyId: string };

/** Settings are organization-wide, so a caller limited to domains can't change them. */
function assertMayManage(caller: ObservationCaller): void {
  if (caller.domainIds.length > 0) {
    throw new ApiError("key_not_scoped", "This key is limited to domains, so it can't change observations.");
  }
}

/** The observation's name, or the key when no file defines it. */
export function observationTitle(key: string): string {
  return OBSERVATIONS.find((candidate) => candidate.key === key)?.title ?? key;
}

function observationFor(key: string): Observation {
  const observation = OBSERVATIONS.find((candidate) => candidate.key === key);
  if (!observation) throw new ApiError("validation_failed", `No observation named ${key}.`, { field: "observation" });
  return observation;
}

/** "for the order-confirmation tag", "for key Production". */
function scope(target: { tag: string | null; keyName: string | null }): string {
  return target.tag !== null ? `for the ${target.tag} tag` : `for key ${target.keyName ?? "unknown"}`;
}

/** Every registered observation, whether it's on and its mutes. Rows for a key no file defines are left out. */
export async function listObservationSettings(organizationId: string): Promise<ObservationSetting[]> {
  const rows = await db
    .select({
      id: observationMutes.id,
      key: observationMutes.key,
      tag: observationMutes.tag,
      apiKeyId: observationMutes.apiKeyId,
      keyName: apiKeys.name,
      createdAt: observationMutes.createdAt,
    })
    .from(observationMutes)
    .leftJoin(apiKeys, eq(apiKeys.id, observationMutes.apiKeyId))
    .where(eq(observationMutes.organizationId, organizationId))
    .orderBy(asc(observationMutes.createdAt));

  return OBSERVATIONS.map((observation) => {
    const own = rows.filter((row) => row.key === observation.key);
    return {
      key: observation.key,
      title: observation.title,
      description: observation.description,
      on: !own.some((row) => row.tag === null && row.apiKeyId === null),
      mutableBy: observation.mutableBy,
      mutes: own.flatMap((row): MuteView[] => {
        if (row.tag !== null) return [{ id: row.id, kind: "tag", label: row.tag, createdAt: row.createdAt }];
        if (row.apiKeyId !== null) return [{ id: row.id, kind: "key", label: row.keyName ?? row.apiKeyId, createdAt: row.createdAt }];
        return [];
      }),
    };
  });
}

/** Mutes an observation for one tag or one key, and says which. Muting what's already muted changes nothing. */
export async function muteObservation(caller: ObservationCaller, key: string, target: MuteTarget): Promise<string> {
  assertMayManage(caller);
  const observation = observationFor(key);
  const kind: MuteKind = "tag" in target ? "tag" : "key";
  if (!observation.mutableBy.includes(kind)) {
    throw new ApiError("validation_failed", `${observation.title} can't be muted by ${kind}.`, { field: kind });
  }

  let tag: string | null = null;
  let keyName: string | null = null;
  let apiKeyId: string | null = null;
  if ("tag" in target) {
    tag = target.tag.trim();
    if (tag.length < 1 || tag.length > 64) throw new ApiError("validation_failed", "A tag is 1 to 64 characters.", { field: "tag" });
  } else {
    const [row] = await db
      .select({ id: apiKeys.id, name: apiKeys.name })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, target.keyId), eq(apiKeys.organizationId, caller.organizationId)));
    if (!row) throw new ApiError("not_found", `No key with id ${target.keyId}.`);
    apiKeyId = row.id;
    keyName = row.name;
  }

  const inserted = await db
    .insert(observationMutes)
    .values({ id: newId("observationMute"), organizationId: caller.organizationId, key, tag, apiKeyId, createdBy: caller.userId })
    .onConflictDoNothing()
    .returning({ id: observationMutes.id });
  const muted = scope({ tag, keyName });
  if (!inserted[0]) return muted;

  await recordActivity({
    organizationId: caller.organizationId,
    action: "settings.observation.muted",
    actor: caller.actor,
    appliesTo: inserted[0].id,
    subjectLabel: `${observation.title} ${muted}`,
    metadata: { observation: key, tag, api_key_id: apiKeyId },
  });
  return muted;
}

/** Removes one tag or key mute. */
export async function unmuteObservation(caller: ObservationCaller, muteId: string): Promise<void> {
  assertMayManage(caller);
  const [row] = await db
    .delete(observationMutes)
    .where(
      and(
        eq(observationMutes.id, muteId),
        eq(observationMutes.organizationId, caller.organizationId),
        or(isNotNull(observationMutes.tag), isNotNull(observationMutes.apiKeyId)),
      ),
    )
    .returning();
  if (!row) throw new ApiError("not_found", `No mute with id ${muteId}.`);

  const observation = OBSERVATIONS.find((candidate) => candidate.key === row.key);
  const [key] = row.apiKeyId ? await db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, row.apiKeyId)) : [];
  await recordActivity({
    organizationId: caller.organizationId,
    action: "settings.observation.unmuted",
    actor: caller.actor,
    appliesTo: row.id,
    subjectLabel: `${observation?.title ?? row.key} ${scope({ tag: row.tag, keyName: key?.name ?? null })}`,
    metadata: { observation: row.key, tag: row.tag, api_key_id: row.apiKeyId },
  });
}

/** Turns an observation on or off for the whole organization. Setting it to what it is changes nothing. */
export async function setObservationOn(caller: ObservationCaller, key: string, on: boolean): Promise<void> {
  assertMayManage(caller);
  const observation = observationFor(key);
  const whole = and(eq(observationMutes.organizationId, caller.organizationId), eq(observationMutes.key, key), isNull(observationMutes.tag), isNull(observationMutes.apiKeyId));

  const changed = on
    ? await db.delete(observationMutes).where(whole).returning({ id: observationMutes.id })
    : await db
        .insert(observationMutes)
        .values({ id: newId("observationMute"), organizationId: caller.organizationId, key, createdBy: caller.userId })
        .onConflictDoNothing()
        .returning({ id: observationMutes.id });
  if (changed.length === 0) return;

  await recordActivity({
    organizationId: caller.organizationId,
    action: on ? "settings.observation.turned_on" : "settings.observation.turned_off",
    actor: caller.actor,
    appliesTo: key,
    subjectLabel: observation.title,
    metadata: { observation: key },
  });
}

