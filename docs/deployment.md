# Deployment

This document describes how Hale deploys to production.

## Topology

```
              ┌─────────────────────────┐
              │   Cloudflare DNS + CDN  │
              └────────────┬────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
     ┌────────────────────┐    ┌────────────────────┐
     │  Vercel            │    │  Supabase          │
     │  hale-web (Next.js)│    │  Toronto           │
     │  + /api/cron/*     │───▶│  Postgres +        │
     │  marketing site    │    │  Storage           │
     └────────────────────┘    └────────────────────┘
```

Production is two hosts. **Vercel** serves `hale-web` (the app) and the marketing site, and runs scheduled work as Cron jobs against `/api/cron/*`. **Supabase Toronto** is Postgres and object storage. There is no separate worker host. `apps/worker` is the library `/api/cron/drain` imports (yul1).

Both hosts are in Canadian regions for PIPEDA / Quebec Law 25 data residency. `hale-web` functions are pinned to `yul1` (Montreal) in `apps/web/vercel.json`. Supabase is `ca-central-1` (Toronto).

## Environments

| Env | Web | Scheduled work | DB | Branch |
|---|---|---|---|---|
| local | `localhost:3000` | same `/api/cron/*` routes on the web app | Supabase local | feature |
| preview | `hale-<sha>.vercel.app` | crons do not run on preview | dev Supabase | feature PRs |
| production | `hale.family` | Vercel Cron → `/api/cron/*` on `hale-web` | prod Supabase | `production` |

## First-time deploy (in order)

1. **Supabase project (Toronto region)** — create in dashboard, capture `DATABASE_URL` + `DATABASE_DIRECT_URL`.
2. **Run migrations** — `pnpm db:migrate` from local with the production DB URLs.
3. **Clerk** — create production application, get keys.
4. **Doppler** — set up `hale-prod` config with all `.env.example` keys filled.
5. **Vercel** — `vercel link` the `hale-web` project, set env vars (including `CRON_SECRET`) via Doppler integration, deploy. The cron schedule is `apps/web/vercel.json`; handlers live under `apps/web/app/api/cron/*`.
6. **DNS** — point `hale.family` at Vercel.
7. **Webhooks** — register Gmail watch, Calendar watch, Stripe webhooks against `https://hale.family/api/webhooks/<provider>`.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
- Every PR reports **Lint, typecheck, test, build**. That check passes when workspace lint, typecheck, test, and build pass, and when the cached-only worker evals pass or were skipped.
- A diff limited to `apps/site/**` (including a `pnpm-lock.yaml` change that only touches the site importer and site-only package entries) skips the worker eval job. `apps/web`, `apps/worker`, `packages/agent`, and the shared packages (`packages/types`, `packages/db`, `packages/tools-contracts`) keep those evals.
- Branch protection should require **Lint, typecheck, test, build**. That job already fails when evals were required and did not pass. **Worker evals (cached-only)** is skipped on site-only PRs; requiring that name on its own leaves those PRs waiting on a skipped check.
- On merge to `main`:
  - Vercel auto-deploys `hale-web` (app + `/api/cron/*`) and the marketing site.
  - `.github/workflows/deploy.yml` applies Supabase migrations and runs the drift check when `DATABASE_DIRECT_URL` is set. It does not deploy a worker.

## Rollback

- Web and crons: Vercel dashboard → Deployments → Promote previous. Promoting a deployment rolls back `hale-web` and its `/api/cron/*` handlers together.
- DB: never roll back schema in prod; forward-fix only. Restore from Supabase PITR if a migration is bad.

## Health checks

- Web: `https://hale.family/api/health`
- Crons: each `/api/cron/*` route requires `Authorization: Bearer <CRON_SECRET>`. A missing or wrong bearer returns 401 and does no work.

## Cost expectations (initial)

| Item | Monthly (CAD) | Notes |
|---|---|---|
| Vercel Pro | $20 | `hale-web` functions pinned to `yul1` |
| Supabase Pro | $25 | Required for Toronto region + backups |
| Doppler | $0–18 | Free tier sufficient initially |
| Sentry | $0 | Developer plan free |
| Langfuse Cloud | $0 | Free tier sufficient for early traffic |
| Anthropic API | variable | Target: ≤$5 per family per month at scale |

Total fixed: ~$45–63 CAD/month before LLM costs.
