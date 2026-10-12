# deploy

How to run a Conus server is in the [README](../README.md#1-run-the-server) ([по-русски](../README.ru.md#1-поднимите-сервер)).
The files here:

| File | What it is |
|---|---|
| `install.sh` | The installer: `curl -fsSL https://raw.githubusercontent.com/Pandusss/conus/main/deploy/install.sh \| sh`. Fetches `compose.yml` and `Caddyfile`, writes `.env`, starts the server. Running it again updates everything but `.env`. |
| `compose.yml` | Postgres and the app from `ghcr.io/pandusss/conus`; Caddy with Let's Encrypt behind the `https` profile. |
| `Caddyfile` | The HTTPS reverse proxy for `CONUS_DOMAIN`. |
| `.env.example` | Every setting, with comments. |
| `Dockerfile` | The app image (built by the release workflow for amd64 and arm64). |
| `compose.build.yml` | Builds the image from this checkout: `docker compose -f compose.yml -f compose.build.yml up -d --build`. |
| `compose.dev.yml` | Postgres for development; `npm run dev` starts it. |
