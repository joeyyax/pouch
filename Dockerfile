# One image, three entry points: scripts/start.sh runs the app, `node --import tsx worker/index.ts`
# the sender and `node --import tsx smtp/index.ts` the SMTP ingress. No pnpm: it doesn't forward SIGTERM.

FROM node:22-slim AS base
# Shared corepack cache so the unprivileged runtime user doesn't re-download pnpm.
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate && chmod -R a+rX $COREPACK_HOME

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Gate: typecheck, lint, docs check and the unit tests. A failing tree builds no image and the old
# containers keep running. Runs before `builder`: tsc and next build together outgrow a 5 GiB
# BuildKit limit.
# Integration tests need Postgres and Redis and stay out (`pnpm test` runs them).
# Compose parity is skipped: a deploy platform may rewrite the compose file before building.
FROM deps AS gate
WORKDIR /app
COPY . .
RUN cp .env.example .env \
 && pnpm typecheck && pnpm lint && pnpm check:docs && pnpm vitest run --config vitest.unit.config.ts --exclude tests/unit/compose-env-parity.test.ts \
 && touch /gate-passed

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=gate /gate-passed /tmp/gate-passed
COPY . .
# next start reads public/ from disk; keep the copy below valid whether or not it exists.
RUN mkdir -p public
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
RUN pnpm build

# Which deploy an error came from. Empty in a local build, which is fine — GLITCHTIP_DSN is
# also unset there, so nothing reports.
ARG GIT_SHA=""

# Runtime-only node_modules: no typescript, eslint, tailwind, drizzle-kit, vitest, playwright-core.
# tsx is a dependency (not a devDependency) because scripts/migrate.ts and worker/index.ts run
# through it in production — see the PR for why this beats a plain `pnpm prune --prod`.
FROM base AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
ENV WORKER_HEALTH_PORT=3101
ENV SMTP_HEALTH_PORT=3102
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends tini ca-certificates wget \
 && apt-get clean && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --create-home app

COPY --from=prod-deps --chown=app:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=app:nodejs /app/package.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=builder --chown=app:nodejs /app/.next ./.next
COPY --from=builder --chown=app:nodejs /app/public ./public
COPY --from=builder --chown=app:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=app:nodejs /app/lib ./lib
COPY --from=builder --chown=app:nodejs /app/worker ./worker
COPY --from=builder --chown=app:nodejs /app/smtp ./smtp
COPY --from=builder --chown=app:nodejs --chmod=755 /app/scripts/start.sh ./scripts/
COPY --from=builder --chown=app:nodejs /app/scripts/migrate.ts /app/scripts/seed.ts /app/scripts/reset-admin.ts /app/scripts/convert-provider.ts /app/scripts/replay-inbound.ts /app/scripts/search-reindex.ts /app/scripts/seal-inbound.ts ./scripts/

USER app
EXPOSE 3100 3101 3102 587 465

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["scripts/start.sh"]
