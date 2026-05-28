# Deployment

This document describes how Haru deploys to production.

## Topology

```
              ┌─────────────────────────┐
              │   Cloudflare DNS + CDN  │
              └────────────┬────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌────────────────┐ ┌────────────────┐ ┌────────────────┐
│  Vercel (yyz1) │ │  Fly.io (yyz)  │ │  Supabase      │
│  Next.js web   │ │  Agent Worker  │ │  Toronto       │
│  app           │ │  (long-lived)  │ │  (Postgres +   │
│                │ │                │ │   Storage)     │
└────────────────┘ └────────────────┘ └────────────────┘
        │                  │                  ▲
        │ enqueue          │ consume          │
        └────────► pg-boss queue ◄────────────┘
                  (in Postgres)
```

All three services are in Canadian regions for PIPEDA / Quebec Law 25 data residency.

## Environments

| Env | Web | Worker | DB | Branch |
|---|---|---|---|---|
| local | `localhost:3000` | `localhost:4000` | Supabase local | feature |
| preview | `haru-<sha>.vercel.app` | shared dev worker | dev Supabase | feature PRs |
| production | `haru.family` | `haru-worker.fly.dev` | prod Supabase | `production` |

## First-time deploy (in order)

1. **Supabase project (Toronto region)** — create in dashboard, capture `DATABASE_URL` + `DATABASE_DIRECT_URL`.
2. **Run migrations** — `pnpm db:migrate` from local with the production DB URLs.
3. **Clerk** — create production application, get keys.
4. **Doppler** — set up `haru-prod` config with all `.env.example` keys filled.
5. **Vercel** — `vercel link`, set env vars via Doppler integration, deploy.
6. **Fly.io worker** — `fly launch --config infra/fly.toml --no-deploy`, then `fly secrets set ...` for each env var, then `fly deploy`.
7. **DNS** — point `haru.family` at Vercel; `worker.haru.family` at Fly (internal only — not exposed publicly).
8. **Webhooks** — register Gmail watch, Calendar watch, Stripe webhooks against `https://haru.family/api/webhooks/<provider>`.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
- Runs lint + typecheck + build on every PR.
- On merge to `production`:
  - Vercel auto-deploys web app.
  - Fly.io deploy triggered (requires manual `fly deploy` or GitHub Action — TODO).

## Rollback

- Web: Vercel dashboard → Deployments → Promote previous.
- Worker: `fly releases list` → `fly releases rollback <version>`.
- DB: never roll back schema in prod; forward-fix only.

## Health checks

- Web: `https://haru.family/api/health`
- Worker: Fly internal health check on `:4000/health`

## Cost expectations (initial)

| Item | Monthly (CAD) | Notes |
|---|---|---|
| Vercel Pro | $20 | Required for `yyz1` edge |
| Fly.io worker (1 machine, 1 vCPU, 1GB) | $10–15 | Auto-scales with traffic |
| Supabase Pro | $25 | Required for Toronto region + backups |
| Doppler | $0–18 | Free tier sufficient initially |
| Sentry | $0 | Developer plan free |
| Langfuse Cloud | $0 | Free tier sufficient for early traffic |
| Anthropic API | variable | Target: ≤$5 per family per month at scale |

Total fixed: ~$55-80 CAD/month before LLM costs.
