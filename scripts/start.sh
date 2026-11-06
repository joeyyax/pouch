#!/bin/sh
# Migrates, then execs next so tini's SIGTERM reaches it.
set -e
node --import tsx scripts/migrate.ts
exec node node_modules/next/dist/bin/next start --port "${PORT:-3100}"
