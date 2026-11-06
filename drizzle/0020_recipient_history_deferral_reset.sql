-- deferred_count now bounds to deferrals since the last delivery, not a lifetime total (#46
-- follow-up). Rows already carrying an inflated lifetime count self-correct on their next
-- event, but a row that recovered before this shipped and never gets another event would keep
-- showing a stale count — so reset it here for every row already recovered under the new rule.
UPDATE "recipient_history"
SET "deferred_count" = 0
WHERE "last_delivered_at" IS NOT NULL
  AND ("last_deferred_at" IS NULL OR "last_delivered_at" >= "last_deferred_at");
