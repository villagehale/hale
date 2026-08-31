#!/usr/bin/env bash
# Local runner for the CI web-smoke walk (.github/workflows/web-smoke.yml) — the
# same flow against a local EPHEMERAL database: provision Postgres, build the web
# app, migrate, seed the PII-free fixtures, then Playwright-walk the authed
# flag-on pages via `next start` on port 3100.
#
# Database, in order of preference (never half-runs — no DB means a named exit):
#   1. SMOKE_DATABASE_URL   — bring-your-own ephemeral LOCAL database
#   2. Docker               — a throwaway postgres:16 container (CI parity)
#   3. initdb + pg_ctl      — a throwaway local instance from Postgres binaries
#
# Nothing here touches prod or real env: DATABASE_URL/DATABASE_DIRECT_URL point at
# the throwaway DB, AUTH_SECRET/APP_ENCRYPTION_KEY are generated per run, and every
# real service key that .env/.env.local could feed the server is explicitly blanked
# (an exported var wins over dotenv in Next; empty reads as not_configured).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PG_PORT="${SMOKE_PG_PORT:-54329}"
CLEANUP=""
DATA_DIR=""

teardown() {
  if [[ "$CLEANUP" == "docker" ]]; then
    docker stop hale-smoke-pg >/dev/null 2>&1 || true
  elif [[ "$CLEANUP" == "pgctl" && -n "$DATA_DIR" ]]; then
    pg_ctl -D "$DATA_DIR" stop -m immediate >/dev/null 2>&1 || true
    rm -rf "$DATA_DIR"
  fi
}
trap teardown EXIT

if [[ -n "${SMOKE_DATABASE_URL:-}" ]]; then
  DB_URL="$SMOKE_DATABASE_URL"
  echo "smoke: using SMOKE_DATABASE_URL (the seed still refuses non-local hosts)"
elif docker info >/dev/null 2>&1; then
  echo "smoke: starting a throwaway postgres:16 container on 127.0.0.1:${PG_PORT}"
  docker rm -f hale-smoke-pg >/dev/null 2>&1 || true
  docker run -d --rm --name hale-smoke-pg \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hale_smoke \
    -p "127.0.0.1:${PG_PORT}:5432" postgres:16 >/dev/null
  CLEANUP="docker"
  for _ in $(seq 1 60); do
    docker exec hale-smoke-pg pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  DB_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/hale_smoke"
elif command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1; then
  echo "smoke: docker unavailable — throwaway local Postgres (initdb/pg_ctl) on 127.0.0.1:${PG_PORT}"
  DATA_DIR="$(mktemp -d /tmp/hale-smoke-pg.XXXXXX)"
  initdb -D "$DATA_DIR" -U postgres -A trust >/dev/null
  pg_ctl -D "$DATA_DIR" -l "$DATA_DIR/pg.log" -w \
    -o "-p ${PG_PORT} -k ${DATA_DIR} -c listen_addresses=127.0.0.1" start >/dev/null
  CLEANUP="pgctl"
  psql -h 127.0.0.1 -p "$PG_PORT" -U postgres -c 'CREATE DATABASE hale_smoke' >/dev/null
  DB_URL="postgresql://postgres@127.0.0.1:${PG_PORT}/hale_smoke"
else
  cat >&2 <<'EOF'
smoke: no database available — not running (never half-runs).
  Provide ONE of:
    - Docker running (a throwaway postgres:16 container will be started), or
    - Postgres binaries on PATH (initdb + pg_ctl; brew install postgresql), or
    - SMOKE_DATABASE_URL pointing at an ephemeral LOCAL database.
EOF
  exit 2
fi

export DATABASE_URL="$DB_URL"
export DATABASE_DIRECT_URL="$DB_URL"
AUTH_SECRET="$(openssl rand -base64 32)"
APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export AUTH_SECRET APP_ENCRYPTION_KEY
export F14_RECEIPTS_IA=true
export ADMIN_PHONES=+14165550123

# Blank every real service key .env/.env.local could otherwise hand the server.
export LANGFUSE_PUBLIC_KEY= LANGFUSE_SECRET_KEY= LANGFUSE_BASE_URL= LANGFUSE_HOST= \
  ANTHROPIC_API_KEY= TWILIO_ACCOUNT_SID= TWILIO_AUTH_TOKEN= \
  POSTHOG_PERSONAL_API_KEY= POSTHOG_PROJECT_ID= SUPABASE_URL= \
  RESEND_API_KEY= GOOGLE_OAUTH_CLIENT_ID= GOOGLE_OAUTH_CLIENT_SECRET= \
  STRIPE_SECRET_KEY= STRIPE_WEBHOOK_SECRET= \
  NEXT_PUBLIC_POSTHOG_KEY= NEXT_PUBLIC_POSTHOG_HOST=

pnpm --filter @hale/web exec playwright install chromium
pnpm --filter @hale/web... build
pnpm --filter @hale/db migrate
pnpm --filter @hale/web seed:e2e-smoke
pnpm --filter @hale/web test:smoke

echo "smoke: PASS — screenshots in apps/web/e2e-artifacts/screens/, server log in apps/web/e2e-artifacts/next-server.log"
