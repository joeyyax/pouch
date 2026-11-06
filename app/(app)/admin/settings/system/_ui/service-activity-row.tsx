import { actorName } from "@/lib/activity/labels";
import { phraseFor } from "@/lib/activity/taxonomy";
import type { ActivityListItem } from "@/lib/activity/types";
import { Time } from "../../../../_ui/time";

/**
 * One service activity row, shared by the Status summary and the full view. The subject is the
 * write-time label rather than a link — it lives in another organization, or in none.
 */
export function ServiceActivityRow({ row }: { row: ActivityListItem }) {
  const phrase = phraseFor(row.action);
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border p-5 last:border-b-0">
      <p className="min-w-0 text-foreground">
        <span className="font-semibold">{actorName(row.actor)}</span> <span className="text-foreground-soft">{phrase.text}</span>
        {phrase.standalone || !row.subjectLabel ? null : <span className="font-semibold"> {row.subjectLabel}</span>}
      </p>
      <Time date={row.createdAt} className="type-body-sm shrink-0 text-muted-foreground" />
    </li>
  );
}
