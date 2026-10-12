#!/bin/sh
# Installs (or updates) a Conus server with Docker:
#   curl -fsSL https://raw.githubusercontent.com/Pandusss/conus/main/deploy/install.sh | sh
# It puts compose.yml, Caddyfile and .env into ./conus, starts the server and prints the address and the setup code.
# Running it again updates the files and the image and keeps .env (your database password and settings).
# Without a terminal (CI), set CONUS_DOMAIN to use the built-in HTTPS, or leave it empty for http://localhost.
set -eu

SOURCE=${CONUS_SOURCE:-https://raw.githubusercontent.com/Pandusss/conus/main/deploy}
DIR=${CONUS_DIR:-conus}

say() { printf '%s\n' "$*"; }
fail() { printf 'conus: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "Docker is required: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the 'docker compose' command)."

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$SOURCE/$1" -o "$1.tmp"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$1.tmp" "$SOURCE/$1"
  else fail "curl or wget is required."
  fi
  mv "$1.tmp" "$1"
}

# Answers come from the terminal even when the script itself arrives through a pipe (curl | sh).
ask() {
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    printf '%s' "$1" > /dev/tty
    IFS= read -r answer < /dev/tty || answer=''
    printf '%s' "$answer"
  fi
}

# Letters and digits only: the password goes into a connection URL as is.
random_hex() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
setup_code() {
  c=$(LC_ALL=C tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' < /dev/urandom | head -c 8)
  printf '%s-%s' "$(printf '%s' "$c" | cut -c1-4)" "$(printf '%s' "$c" | cut -c5-8)"
}

mkdir -p "$DIR"
cd "$DIR"
fetch compose.yml
fetch Caddyfile

if [ ! -f .env ]; then
  domain=${CONUS_DOMAIN-}
  if [ -z "${CONUS_DOMAIN+set}" ]; then
    domain=$(ask "Domain for HTTPS, e.g. conus.example.com (empty: run on http://localhost:8080 only): ")
  fi
  lang=${CONUS_LANG:-en}
  code=$(setup_code)
  (
    umask 077
    {
      say "POSTGRES_PASSWORD=$(random_hex)"
      say "CONUS_SETUP_CODE=$code"
      say "CONUS_LANG=$lang"
      if [ -n "$domain" ]; then
        say "COMPOSE_PROFILES=https"
        say "CONUS_DOMAIN=$domain"
        say "CONUS_PUBLIC_URL=https://$domain"
      else
        say "CONUS_PUBLIC_URL=http://localhost:8080"
      fi
      say "ANTHROPIC_API_KEY="
    } > .env
  )
  say "Wrote $(pwd)/.env"
fi

docker compose pull --quiet
docker compose up -d

url=$(sed -n 's/^CONUS_PUBLIC_URL=//p' .env | tail -n 1)
url=${url:-http://localhost:8080}
port=$(sed -n 's/^CONUS_PORT=//p' .env | tail -n 1)
port=${port:-8080}
say "Waiting for the server..."
i=0
until docker compose exec -T app node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || fail "the server did not start; see: cd $(pwd) && docker compose logs app"
  sleep 2
done

code=$(sed -n 's/^CONUS_SETUP_CODE=//p' .env | tail -n 1)
say ""
say "Conus is running: $url"
if [ -n "$code" ]; then
  say "First visit: enter the setup code $code and choose the owner password."
  say "(If the owner password is already set, just log in.)"
fi
say "Then connect your agents: in Conus open Agents → Connect agent, and on each agent machine run"
say "  npm install -g --allow-remote=all https://github.com/Pandusss/conus/releases/latest/download/conus-cli.tgz"
say "  conus setup $url <token>"
case "$url" in http://localhost*) say "The server listens on 127.0.0.1:$port only: agents on other machines need a proxy or the built-in HTTPS." ;; esac
