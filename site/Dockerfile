# Built from the repo root: docker build -f site/Dockerfile .
FROM node:22-slim AS base
ENV COREPACK_HOME=/usr/local/share/corepack
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

# The OpenAPI document, from the route spec.
FROM base AS spec
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY tsconfig.json ./
COPY lib lib
COPY scripts/gen-openapi.ts scripts/
RUN node_modules/.bin/tsx scripts/gen-openapi.ts /openapi.json

FROM base AS docs
WORKDIR /repo/docs-site
COPY docs-site/package.json docs-site/pnpm-lock.yaml docs-site/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY docs-site ./
COPY docs/self-hosting.md docs/leaving.md docs/mcp.md /repo/docs/
COPY docs/api/conventions.md /repo/docs/api/
COPY --from=spec /openapi.json ./openapi.json
RUN pnpm build

FROM caddy:2.10-alpine
COPY site/Caddyfile /etc/caddy/Caddyfile
COPY --chown=root:root site/index.html site/favicon.svg site/robots.txt /srv/
COPY site/assets /srv/assets
COPY --from=docs /repo/docs-site/out /srv/docs
USER 1001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
