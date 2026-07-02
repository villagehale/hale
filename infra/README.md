# Infra

Deployment configuration for Hale.

## Production targets

| Service | Host | Region | Config |
|---|---|---|---|
| Web app (`apps/web`) | Vercel | yul1 functions | `apps/web/vercel.json` (project rootDirectory=`apps/web`) |
| Agent Worker (`apps/worker`) | Fly.io | YYZ (Toronto) | `infra/fly.toml` + `apps/worker/Dockerfile` |
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

The operative config is `apps/web/vercel.json` (picked up via the project's rootDirectory) — Montreal functions (`yul1`), Turbo-based build, and the cron schedule.

### 3. Fly.io worker

```bash
fly launch --config infra/fly.toml --no-deploy
fly secrets set DATABASE_URL=... ANTHROPIC_API_KEY=...
fly deploy --config infra/fly.toml
```

Verify the worker is consuming the queue:

```bash
fly logs --app hale-worker
```

### 4. Doppler secrets

```bash
doppler setup
doppler secrets upload .env.local
```

## Health checks

- Web: `GET https://hale.family/api/health`
- Worker: `GET https://hale-worker.fly.dev/health` (via Fly's internal health check)

## Disaster recovery

- Postgres: Supabase daily backups, 7-day retention, Toronto region.
- Worker: Stateless; redeploy from `main`.
- Vercel: Automatic rollback via dashboard.
