import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { cursorToQuery } from "@/lib/activity/filter";
import type { ActivityCursor, ActivityListItem } from "@/lib/activity/types";
import { SectionHeader } from "../../../../_ui/section-header";
import { ServiceActivityRow } from "../_ui/service-activity-row";

const PATH = "/admin/settings/system/activity";

export function ServiceActivityScreen({
  rows,
  nextCursor,
  paged,
}: {
  rows: ActivityListItem[];
  nextCursor: ActivityCursor | null;
  /** Whether this page is reached by paging back from a newer one. */
  paged: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <SectionHeader
        title="Service activity"
        description="Admin actions outside any one organization, like granting admin access or deleting an organization."
      />

      <Card className="overflow-hidden p-0">
        {rows.length === 0 ? (
          <EmptyState
            icon="clock"
            title={paged ? "Nothing older" : "No service activity yet"}
            description={
              paged
                ? "This is the end of the log."
                : "Admin changes land here as they happen."
            }
          />
        ) : (
          <ul>
            {rows.map((row) => (
              <ServiceActivityRow key={row.id} row={row} />
            ))}
          </ul>
        )}
      </Card>

      {paged || nextCursor ? (
        <div className="flex items-center justify-between text-sm">
          {paged ? (
            <Link href={PATH} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Newest
            </Link>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Link href={`${PATH}?${cursorToQuery(nextCursor)}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Older
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
