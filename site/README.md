# site

The marketing site at pouch.email. Static files served by Caddy; no build step.

```bash
docker build -t pouch-site site && docker run --rm -p 8080:8080 pouch-site
```

Anything the site doesn't have redirects to app.pouch.email, so links from before the app moved keep working. Self-hosted installs don't run it.
