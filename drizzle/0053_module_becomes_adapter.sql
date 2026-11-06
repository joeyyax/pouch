-- The column stores "ses" or "mailpace" — the adapter's name (#375). A rename carries the
-- identity index with it, so providers_identity_idx needs no rebuild.
ALTER TABLE "providers" RENAME COLUMN "module" TO "adapter";
