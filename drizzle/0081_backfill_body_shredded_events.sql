INSERT INTO "message_events" ("id", "organization_id", "message_id", "kind", "status", "detail", "occurred_at")
SELECT
  'evt_' || (SELECT string_agg(substr('0123456789abcdefghijklmnopqrstuvwxyz', 1 + floor(random() * 36)::int, 1), '') FROM generate_series(1, 24) AS g WHERE m."id" IS NOT NULL),
  m."organization_id",
  m."id",
  'body_shredded',
  NULL,
  '{"retentionDays": null}'::jsonb,
  coalesce(m."body_purged_at", m."updated_at")
FROM "messages" m
WHERE m."body_withheld" IS NOT NULL
  AND m."body_key" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "message_events" e WHERE e."message_id" = m."id" AND e."kind" = 'body_shredded'
  );
