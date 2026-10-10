# Infra

Deployment configuration for Hale.

## Production targets

| Service | Host | Region | Config |
|---|---|---|---|
| Web app (`apps/web`) | Vercel | yul1 functions | `apps/web/vercel.json` (project rootDirectory=`apps/web`) |
| Agent worker code (`apps/worker`) | Vercel `/api/cron/drain` | yul1 | Imported by the web app; no separate host |
| Postgres | Supabase | ca-central-1 (Toronto) | `infra/supabase/config.toml` (local emulator) |
| Object storage | Supabase Storage | ca-central-1 | Configured in Supabase dashboard |
| Secrets | Doppler | — | Set up per-environment via Doppler CLI |
| Observability | Sentry + Langfuse | — | `SENTRY_DSN`, `LANGFUSE_*` env vars |

All data residency is **Canadian**. PIPEDA + Quebec Law 25 + CASL compliance baked in at the infra level.

## First-time setup

### 1. Supabase project

```bash
# Create project in Supabase dashboard in Toronto region.
# Then locally:
supabase link --project-ref <your-project-ref>
supabase db push   # applies Drizzle-generated SQL
```

### 2. Vercel project

```bash
vercel link
vercel env pull .env.local         # pulls secrets
vercel --prod                       # deploys
```

The operative config is `apps/web/vercel.json` (picked up via the project's rootDirectory) — Montreal functions (`yul1`), Turbo-based build, and the cron schedule. Worker code runs inside `/api/cron/drain` on those functions. There is no separate worker host.

### 3. Doppler secrets

```bash
doppler setup
doppler secrets upload .env.local
```

## Health checks

- Web: `GET https://hale.family/api/health`
- Queue drain: Vercel Cron `GET /api/cron/drain` (yul1), every minute

## Disaster recovery

- Postgres: Supabase daily backups, 7-day retention, Toronto region.
- Worker code: ships with the Vercel web deploy (`/api/cron/drain`).
- Vercel: Automatic rollback via dashboard.
