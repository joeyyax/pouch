/**
 * One importer for both `POST /v1/lists/:id/members { members: [...] }` (JSON) and a CSV
 * upload — the dashboard's file input and `POST /v1/lists/:id/members` with a `text/csv` body.
 * Sharing this means `confirmed: true` handling, membership sourcing (`import`) and the
 * pending-by-default rule can't drift between the two: both end up calling the exact same
 * `addMembership` for every row.
 *
 * A row that fails doesn't fail the batch — the caller usually can't fix a bad address in the
 * request body anyway, only in the file, so aborting on the first bad row would mean re-sending
 * everything after fixing one line. Each row's outcome is reported instead.
 */
import { safeErrorMessage } from "@/lib/errors/scrub";
import { recordActivity } from "@/lib/activity/record";
import type { ListRow } from "@/lib/db/schema";
import { parseMemberCsv } from "./csv-import";
import type { ListCaller } from "./index";
import { addMembership } from "./members";
import { serializeMembership, type SerializedMembership } from "./serialize";

export interface ImportRow {
  address: string;
  attributes?: Record<string, string>;
  /** Marks this row confirmed by the importer, skipping double opt-in for it specifically. */
  confirmed?: boolean;
  /** 1-based source line in the uploaded file. Undefined for a JSON import — there's no "line". */
  line?: number;
}

export interface ImportRowError {
  /** Null for a JSON import. */
  line: number | null;
  address: string;
  message: string;
}

export interface ImportResult {
  imported: SerializedMembership[];
  errors: ImportRowError[];
  /** Memberships this import created; the rest of `imported` were already on the list. */
  added: number;
}

export interface ImportMembersInput {
  organizationId: string;
  listId: string;
  doubleOptIn: boolean;
  rows: ImportRow[];
  /** Applies to a row that doesn't set its own `confirmed`. */
  defaultConfirmed?: boolean;
}

export async function importMembers(input: ImportMembersInput): Promise<ImportResult> {
  const imported: SerializedMembership[] = [];
  const errors: ImportRowError[] = [];
  let added = 0;

  for (const row of input.rows) {
    try {
      const { membership, created } = await addMembership({
        organizationId: input.organizationId,
        listId: input.listId,
        address: row.address,
        source: "import",
        doubleOptIn: input.doubleOptIn,
        attributes: row.attributes,
        confirmed: row.confirmed ?? input.defaultConfirmed,
      });
      imported.push(serializeMembership(membership));
      if (created) added++;
    } catch (err) {
      const message = safeErrorMessage(err);
      errors.push({ line: row.line ?? null, address: row.address, message });
    }
  }

  return { imported, errors, added };
}

export interface ImportCounts {
  added: number;
  already_present: number;
  invalid: number;
}

/** Repeats within one import count as already present. */
export function importCounts(result: ImportResult): ImportCounts {
  return {
    added: result.added,
    already_present: result.imported.length - result.added,
    invalid: result.errors.length,
  };
}

/**
 * One summary row with counts, never addresses, so a purge doesn't have to reach into the log.
 * An import that added nothing logs nothing.
 */
export async function recordImportActivity(caller: ListCaller, list: ListRow, result: ImportResult): Promise<void> {
  if (result.added === 0) return;
  await recordActivity({
    organizationId: caller.organizationId,
    action: "list.members.imported",
    actor: caller.actor,
    appliesTo: list.id,
    subjectLabel: list.name,
    metadata: { ...importCounts(result) },
  });
}

/** A CSV file into a list, for the API's `text/csv` body and the dashboard's upload alike. */
export async function importMemberCsv(caller: ListCaller, list: ListRow, text: string): Promise<ImportResult> {
  const parsed = parseMemberCsv(text);
  const result = await importMembers({
    organizationId: caller.organizationId,
    listId: list.id,
    doubleOptIn: list.doubleOptIn,
    rows: parsed.rows,
  });
  result.errors.push(...parsed.errors);
  result.errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  await recordImportActivity(caller, list, result);
  return result;
}
