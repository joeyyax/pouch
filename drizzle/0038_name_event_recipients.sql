-- SES delivery rows written before recipients were stored on the event.
UPDATE "message_events"
SET "detail" = "detail" || jsonb_build_object('recipients', "detail" -> 'delivery' -> 'recipients')
WHERE "kind" = 'transition'
  AND "status" = 'delivered'
  AND NOT "detail" ? 'recipients'
  AND jsonb_typeof("detail" -> 'delivery' -> 'recipients') = 'array'
  AND jsonb_array_length("detail" -> 'delivery' -> 'recipients') > 0;
