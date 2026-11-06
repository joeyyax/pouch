/** Adding, removing and file-importing an organization's suppressions. Every surface calls these. */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { suppressions } from "@/lib/db/schema";
import { isEmailAddress, normalizeAddress } from "@/lib/addresses";
import { ApiError } from "@/lib/api/errors";
import { recordActivity } from "@/lib/activity/record";
import type { ActivityActor } from "@/lib/activity/types";
import type { SuppressionReason } from "@/lib/db/schema";
import { importSuppressions, suppress, unsuppress, type SuppressionImportResult } from "./suppression";
import { parseSuppressionCsv } from "./suppression-csv";
import { sessionActor, type DashboardSession } from "@/lib/dashboard/session";
import { formatNumber } from "@/lib/format/number";

/**
 * Adds an address by hand. It's normalized the same way a send is, so a manual entry and a
 * bounce for the same mailbox are one row rather than two that only one of them matches.
 */
export async function addSuppression(
  organizationId: string,
  rawAddress: string,
  note: string | null,
  actor: ActivityActor,
): Promise<string> {
  const address = normalizeAddress(rawAddress);
  if (!isEmailAddress(address)) {
    throw new ApiError("validation_failed", `"${rawAddress}" isn't a valid address.`, { field: "address" });
  }

  const detail = note?.trim() || null;
  const added = await suppress({ organizationId, address, reason: "manual", detail });

  if (!added) {
    throw new ApiError("validation_failed", `${address} is already suppressed.`, { field: "address" });
  }

  const id = await suppressionId(organizationId, address);
  if (id) {
    await recordActivity({
      organizationId,
      action: "suppression.added",
      actor,
      appliesTo: id,
      metadata: { reason: "manual", detail },
    });
  }
  return address;
}

/** Removes an address. Sends to it start going out again. */
export async function removeSuppression(
  organizationId: string,
  rawAddress: string,
  actor: ActivityActor,
): Promise<string> {
  const address = normalizeAddress(rawAddress);
  // Read before the delete: the row's id is the only thing the activity row may reference
  // (lib/activity/query.ts), and unsuppress takes it away.
  const id = await suppressionId(organizationId, address);
  const removed = await unsuppress(organizationId, address);
  if (!removed) throw new ApiError("not_found", `${address} isn't on the suppression list.`);

  if (id) {
    await recordActivity({ organizationId, action: "suppression.removed", actor, appliesTo: id });
  }
  return address;
}

/** The row's id, never the address — see lib/activity/query.ts for why the log references it. */
async function suppressionId(organizationId: string, address: string): Promise<string | null> {
  const [row] = await db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.organizationId, organizationId), eq(suppressions.address, address)))
    .limit(1);
  return row?.id ?? null;
}

/** Rows one dashboard file import takes. */
export const SUPPRESSION_FILE_ROW_LIMIT = 50_000;

/** A provider's whole export in one file, so the dashboard takes more rows than one API call. */
export async function importSuppressionFile(
  session: DashboardSession,
  text: string,
  options: { reason: SuppressionReason; source: string | null },
): Promise<SuppressionImportResult> {
  const parsed = parseSuppressionCsv(text);
  if (parsed.rows.length + parsed.errors.length > SUPPRESSION_FILE_ROW_LIMIT) {
    throw new ApiError(
      "validation_failed",
      `The file has more than ${formatNumber(SUPPRESSION_FILE_ROW_LIMIT)} rows. Split it and import each part.`,
    );
  }
  return importSuppressions({
    organizationId: session.organizationId,
    rows: parsed.rows,
    errors: parsed.errors,
    reason: options.reason,
    source: options.source?.trim() || "CSV import",
    actor: sessionActor(session),
  });
}
