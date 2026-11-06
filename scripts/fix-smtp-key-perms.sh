#!/bin/sh
# Run by mail-certs' --post-hook (docker-compose.traefik.yml) after every dump.
# traefik-certs-dumper writes the private key 0600 root-owned; mail-smtp reads it as uid
# 1001 (the "app" user — see Dockerfile). Chowning to that uid keeps the key 0600 instead of
# widening it to world-readable.
set -e
chown 1001:1001 "$1"
chmod 600 "$1"
