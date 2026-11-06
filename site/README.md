# site

The marketing site and docs at pouch.email, served by Caddy. The landing page is static files here; `/docs` is the static export of `docs-site/`, built in the image.

```bash
docker build -f site/Dockerfile -t pouch-site . && docker run --rm -p 8080:8080 pouch-site
```

The build context is the repo root: the docs need `lib/api-docs/spec.ts` for the reference and the guides in `docs/`. `site/Dockerfile.dockerignore` keeps the context to those.

Anything the site doesn't have redirects to app.pouch.email, so links from before the app moved keep working. `/self-hosting` and `/leaving` redirect to their pages under `/docs`. Self-hosted installs don't run it.

Asset links carry `?v=` and the first 8 characters of the file's SHA-1. Update them when an asset changes: `shasum site/assets/<file> | cut -c1-8`.

## Docs

`docs-site/` is a Fumadocs app with its own lockfile, so none of its packages reach the app image.

- **Guides** are MDX pages in `docs-site/content/docs/`. Self-hosting, leaving, MCP and API conventions include `docs/self-hosting.md`, `docs/leaving.md`, `docs/mcp.md` and `docs/api/conventions.md`, which stay the source. SMTP is written there.
- **The reference** is one page per route, rendered by fumadocs-openapi from `openapi.json`. `scripts/prepare.mjs` writes it with `scripts/gen-openapi.ts` before `dev` and `build`, and copies the guides into `docs-site/guides/`. Both are gitignored.
- **Search** is Fumadocs' static index at `/docs/search.json`.

```bash
cd docs-site && pnpm install && pnpm dev   # http://localhost:3110/docs/
```
