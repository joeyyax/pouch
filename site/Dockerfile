FROM caddy:2.10-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --chown=root:root index.html favicon.svg robots.txt /srv/
COPY assets /srv/assets
COPY self-hosting /srv/self-hosting
COPY leaving /srv/leaving
USER 1001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
