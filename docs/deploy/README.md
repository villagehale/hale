# Hale — Deployment Runbook

How Hale ships to production: **Vercel** (web + marketing site) + **Fly.io
Toronto/yyz** (the agent worker) + **Supabase Toronto** (Postgres). All
residency-sensitive compute and data stay in Canada (CLAUDE.md hard rule #1:
PIPEDA + Quebec Law 25 + CASL).

> **Status:** deploy-READY config. The live deploy is **credential-gated** — no
> Fly auth, no Supabase project, no Vercel prod token are wired yet. Everything
> below is verifiable without secrets (config validity, Docker build, scratch-DB
> migration test); see [Verification status](#verification-status). See
> [Release blockers](#release-blockers) for historical provisioning blockers (B1
> migration baseline and B2 package entrypoints — both now resolved).

---

## Architecture

```
                      ┌──────────────────────────────────────────────┐
        parent's      │  VERCEL  (global edge; functions pinned yyz1) │
        browser ─────▶│                                              │
                      │  apps/web   (@hale/web)   — app, API routes   │
                      │  apps/site  (@hale/site)  — marketing site    │
                      └───────────────┬──────────────────────────────┘
                                      │  enqueue: queue.send('events.ingested'),
                                      │           queue.send('actions.approved')
                                      │  read:    Drizzle SELECTs
                                      ▼
                      ┌──────────────────────────────────────────────┐
                      │  SUPABASE  Postgres 16  — ca-central-1 (yyz)  │
                      │  app tables + pgboss schema (the job queue)   │
                      └───────────────┬──────────────────────────────┘
                                      │  pg-boss poll (LISTEN/poll)
                                      ▼
                      ┌──────────────────────────────────────────────┐
                      │  FLY.IO  primary_region = yyz (Toronto)       │
                      │  apps/worker (@hale/worker) — pg-boss consumer │
                      │  consumes: events.ingested, actions.approved,  │
                      │            memory.inference.due, digest.daily  │
                      │  calls: Anthropic, Langfuse, Resend            │
                      └──────────────────────────────────────────────┘
```

**The web/worker split is a process boundary, not a folder split.** `apps/web`
*enqueues* and *reads*; the long-running agent compute (LLM calls over newborn
data) runs only on the Fly worker. The async contract between them is the
pg-boss `events.ingested` / `actions.approved` queues in Postgres.

### Data-residency rationale

| Concern | Placement | Why |
|---|---|---|
| Newborn data at rest | Supabase **ca-central-1 (Toronto)** | PIPEDA / Law 25 — data must not leave Canada. |
| Agent compute over that data | Fly **yyz (Toronto)** | The worker reads families/children/events and calls the LLM; it runs in-region so sensitive payloads are processed in Canada. |
| Web layer (Vercel) | **Global edge**, functions pinned `yyz1` | Vercel functions are best-effort region-pinned, and the CDN/edge is global. This is acceptable **because the web layer only enqueues + reads** — it is not where agent reasoning over newborn data happens. `regions: ["yyz1"]` keeps the serverless functions in Toronto where the plan allows; the residency guarantee rests on Supabase + Fly, not Vercel. |
| Object storage | Supabase Storage ca-central-1 | Same residency rule as Postgres. |

---

## Required secrets matrix

Names only — never commit values. `.env.example` is the source of truth for the
full app env; the table below is the **deploy-time** subset per platform.

### Fly.io — worker (`fly secrets set <NAME>=...`)

| Secret | Purpose | Required? |
|---|---|---|
| `DATABASE_URL` | Postgres connection (pooled) — pg-boss + Drizzle | **Yes** (worker won't boot without it — `config.ts` zod `.url()`). |
| `ANTHROPIC_API_KEY` | Claude API for the agent pipeline | Yes (prod). |
| `LANGFUSE_PUBLIC_KEY` | Prompt fetch + tracing (prompts live in Langfuse — rule #2) | Yes (prod). |
| `LANGFUSE_SECRET_KEY` | Langfuse server auth | Yes (prod). |
| `LANGFUSE_HOST` | Langfuse instance URL | Yes (prod). |
| `RESEND_API_KEY` | Outbound email sends (executor) | Yes (any email action). |
| `RESEND_FROM` | Verified sender (default `hello@villagehale.com`) | Yes (any email action). |
| `INTERNAL_API_SHARED_SECRET` | web↔worker internal auth | If used. |

### Vercel — web + site (Project → Settings → Environment Variables, Production)

| Secret | web | site | Purpose |
|---|:--:|:--:|---|
| `DATABASE_URL` | ✓ | — | Reads + enqueue |
| `DATABASE_DIRECT_URL` | ✓ | — | Build-time / non-pooled |
| `ANTHROPIC_API_KEY` | ✓ | — | Web agent pipeline + scheduled cron agents (digest / inference) |
| `RESEND_API_KEY` | ✓ | — | Daily-digest email send (from `hello@villagehale.com`; `RESEND_FROM` optional override) |
| `CRON_SECRET` | ✓ | — | **Required for the scheduled agents.** Vercel sends it as `Authorization: Bearer <CRON_SECRET>`; the cron routes 401 (do no work, no spend) without a match. See [Scheduled agents (cron)](#scheduled-agents-cron). |
| `CLERK_SECRET_KEY` | ✓ | — | Auth |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✓ | — | Auth (public) |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` | ✓ | — | Tracing |
| `APP_URL` / `WORKER_URL` | ✓ | — | Cross-service URLs |
| (none app-specific) | — | ✓ | site is static marketing |

### GitHub Actions — CI/CD deploy (`Settings → Secrets → Actions`)

These drive `.github/workflows/deploy.yml` (which has exactly two legs —
`migrate` and `fly`; Vercel deploys via its own native integration, not here).
**A leg whose secret is absent is skipped with a notice; the pipeline stays
green. A leg that runs without its required secret fails loud.**

| Secret | Gates leg | Notes |
|---|---|---|
| `DATABASE_DIRECT_URL` | `migrate` (+ drift gate) | **Required for prod migrations to apply at all** — see [Migration drift guard](#migration-drift-guard). Direct (non-pooled) URL — drizzle-kit runs DDL in a transaction. |
| `FLY_API_TOKEN` | `fly` | `fly auth token`. |

---

## First-time provisioning

### 1. Supabase (Toronto)

1. Create a project in the Supabase dashboard, **region `ca-central-1`
   (Toronto)**. (`infra/supabase/config.toml` is the local emulator config.)
2. Grab the **pooled** connection string (port 6543, `?pgbouncer=true`) for
   `DATABASE_URL`, and the **direct** string (port 5432) for `DATABASE_DIRECT_URL`.
3. Provision the schema with the migration set (the intended path, verified
   working — see [B1](#b1--production-migration-baseline-resolved)):
   ```bash
   pnpm --filter @hale/db build              # drizzle.config reads dist/schema
   DATABASE_DIRECT_URL=<direct-url> pnpm --filter @hale/db migrate      # applies 0000_baseline … latest
   DATABASE_DIRECT_URL=<direct-url> pnpm --filter @hale/db drift-check  # asserts in sync
   ```
   In production this runs automatically in the `migrate` leg once
   `DATABASE_DIRECT_URL` is set as a GitHub secret
   ([Migration drift guard](#migration-drift-guard)).

### 2. Vercel (web + site = two projects)

Each app is a separate Vercel **project** sharing this repo. Set **Root
Directory = repo root** for both; the build is driven by `--local-config`.

```bash
# In a clean checkout, once per project:
vercel link            # → choose/create the web project
# repeat with the site project for apps/site

# capture ids for CI:
cat .vercel/project.json   # → orgId, projectId  → VERCEL_ORG_ID, VERCEL_PROJECT_ID_*
```

- Web project (`hale-web`, rootDirectory=`apps/web`) uses `apps/web/vercel.json` — functions pinned to `yul1`, crons included. Deploy with a plain `vercel deploy --prod` (no `--local-config`).
- Site project is GitHub-connected and auto-deploys on main pushes (not part of deploy.yml).

#### Scheduled agents (cron)

The passive agentic engine runs in production as **Vercel Cron → API routes** on
the `@hale/agent` harness — no separate worker needed in prod (the pg-boss worker
stays for local/durable). The schedule lives in `apps/web/vercel.json` under
`crons`; the handlers are Node-runtime routes under `apps/web/app/api/cron/*`.

| Route | Schedule (UTC) | Toronto local | Cadence | Does |
|---|---|---|---|---|
| `/api/cron/digest` | `0 12 * * *` | ~07:00 EST / 08:00 EDT | daily, morning | Composes each family's daily brief on the harness (companion health/milestones + this-week village), stores it in `daily_digests`, and emails it via Resend from `hello@villagehale.com`. |
| `/api/cron/inference` | `0 6 * * *` | ~01:00 EST / 02:00 EDT | daily, overnight | Memory inference over each family's recent activity; saves ≥0.7-confidence facts through the guarded `save_memory` tool. |
| `/api/cron/discovery` | `0 13 * * 1` | ~08:00 EST / 09:00 EDT, Mondays | weekly | Village discovery for families whose candidates are stale/empty (reuses `discoverForFamily`). |

**Timezone note:** Vercel cron expressions are **UTC** (no per-cron timezone).
The UTC times above are chosen to land in the Toronto morning/overnight
year-round (the one-hour EST↔EDT drift is acceptable for these cadences). If a
precise local time ever matters, schedule hourly and gate inside the handler on
the Toronto-local hour.

**`CRON_SECRET` is mandatory.** Set it in the web project's Production env
(Vercel auto-injects it as `Authorization: Bearer <CRON_SECRET>` on cron
invocations). Each route verifies it **before any work** — a missing or wrong
bearer (or an unset `CRON_SECRET`) returns 401 and the engine does nothing: no DB
read, no model call, no email, no spend. Generate one with `openssl rand -hex 32`.

**Bounded by construction:** each run processes at most a capped number of
families per invocation (`MAX_FAMILIES_PER_RUN` in `apps/web/lib/cron/families.ts`:
digest 100 / discovery 50 / inference 100), and each per-family agent run is
hard-stopped by the harness (`maxSteps × maxTokens` token ceiling) with every
monetary tool gated by the spending-cap guard (rule #7). So one cron tick can
never fan out across the whole table or blow the budget.

### 3. Fly.io worker (Toronto)

```bash
fly launch --config infra/fly.toml --no-deploy   # creates the hale-worker app, region yyz
fly secrets set \
  DATABASE_URL=... ANTHROPIC_API_KEY=... \
  LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... LANGFUSE_HOST=... \
  RESEND_API_KEY=... RESEND_FROM=... \
  --app hale-worker
fly deploy --config infra/fly.toml --remote-only
fly logs --app hale-worker     # expect: "pg-boss started" → "consumers registered" → "Hale worker ready"
```

The worker is a **non-HTTP** process (a pure pg-boss poller). `infra/fly.toml`
has no `[http_service]` and no HTTP health check — liveness is the Fly restart
policy (`policy = "always"`), and `min` machines is held at 1 so the queue is
always drained.

---

## Deploy flow (CI/CD)

There are **two independent delivery paths** — this is the crucial topology to
understand:

1. **Web + marketing site → Vercel, via the native GitHub integration.** `hale-web`
   and `site` are GitHub-connected Vercel projects; `vercel[bot]` builds and
   promotes a Production deployment on every `main` merge. **This path does NOT
   run database migrations** — Vercel only builds and serves the Next.js app.
2. **DB migrations + worker → `.github/workflows/deploy.yml`**, triggered on **CI
   success on `main`** (`workflow_run`):
   - **preflight** — gates on CI success; resolves which legs have secrets.
   - **migrate** — `drizzle-kit migrate` against Supabase, then a **drift
     verification** (`pnpm --filter @hale/db drift-check`) that asserts the DB is
     now in sync. Runs first; a failure blocks the worker deploy.
   - **fly** (worker) — runs after a clean/skipped migrate.

   Each leg self-asserts its required secret and `exit 1`s loud if invoked
   without it. A leg whose secret is **absent** is SKIPPED (pipeline stays green).

> ⚠️ **The two paths are coupled by the schema, not by CI.** Vercel ships new app
> code that expects new columns; only the `migrate` leg creates them. If the
> `migrate` leg is skipped (its secret is unset) while Vercel keeps deploying,
> **prod code runs against a stale schema and breaks** — exactly the 2026-06-14
> incident (see [Migration drift guard](#migration-drift-guard)). Setting
> `DATABASE_DIRECT_URL` (below) is what closes this gap.

---

## Migration drift guard

**The one manual step that makes migrations reach prod:** set
`DATABASE_DIRECT_URL` as a **GitHub Actions secret**
(`Settings → Secrets and variables → Actions → New repository secret`), to the
Supabase **direct** (port 5432, non-pooled) connection string. This is a
**repo-admin action** — it cannot be done from a PR or by CI. Until it is set,
the `migrate` leg is skipped on every deploy and **no pending migration ever
reaches prod**.

Once set, that single secret enables **both**:

- **Auto-migrate** — `drizzle-kit migrate` applies pending migrations on every
  main deploy.
- **The drift gate** — after applying, `pnpm --filter @hale/db drift-check`
  compares the drizzle journal (`drizzle/meta/_journal.json`) to what the DB has
  actually recorded in `drizzle.__drizzle_migrations` and **fails the deploy
  loudly, listing every un-applied migration, if the DB is behind**. It is
  strictly read-only (a single `SELECT`; it never applies anything) and skips
  with a notice (exit 0) when no DB URL is present.

### The incident this prevents

On **2026-06-14**, prod's schema drifted **12 migrations behind for ~3 weeks**
and nobody noticed. The Village cadence feature was broken in prod because the
`cadence` / `superseded_at` columns (migration `0027_village_cadence`) never
existed there.

**Root cause:** migrations were never auto-applied. The web deploys via Vercel's
native integration (which does not run migrations), and the `deploy.yml` `migrate`
leg was **skipped on every run** because `DATABASE_DIRECT_URL` had never been set
as a GitHub secret. So there was no path that applied pending migrations to prod,
and nothing that alarmed when prod fell behind.

**How the guard prevents recurrence:** the drift-check runs after `migrate` on
every deploy and turns "silently behind" into a **red, blocking deploy** that
names the missing migrations. A human can run the same check locally at any time:

```bash
DATABASE_DIRECT_URL=<direct-url> pnpm --filter @hale/db drift-check   # gate: exit 1 if behind
DATABASE_DIRECT_URL=<direct-url> pnpm --filter @hale/db status        # applied-vs-pending at a glance
```

> **Residual blind spot (by design):** if `DATABASE_DIRECT_URL` is *absent*, both
> the migrate leg **and** the drift-check skip — a green pipeline then only means
> "nothing was checked." That is why setting the secret is a hard prerequisite,
> documented here rather than guarded in code (CI can't invent a secret it was
> never given).

---

## Rollback

### Vercel
```bash
vercel ls <project> --token=$VERCEL_TOKEN          # list deployments, find last-good prod URL
vercel promote <previous-prod-url> --token=$VERCEL_TOKEN
```
`promote` re-points the production domain to a prior deployment (no rebuild).

### Fly (worker)
```bash
fly releases --app hale-worker                     # list versions
fly releases rollback <version> --app hale-worker  # roll to a prior release image
# or: fly deploy --image <previous-image-ref> --app hale-worker
```
The worker is stateless (state lives in Postgres), so rollback is just swapping
the image; in-flight jobs are retried by pg-boss.

### Database
Migrations are **additive only** (CLAUDE.md #9) — there is no automated
down-migration. To recover from a bad migration, restore via **Supabase
Point-in-Time Recovery** (Toronto region) to just before the migration.

---

## Release blockers

### B1 — Production migration baseline (RESOLVED)

**Status:** resolved. `packages/db/drizzle/` now begins with a `0000_baseline.sql`
migration that `CREATE`s the base tables/enums, followed by the additive deltas
(37 migrations total, `0000_baseline` … `0036_village_search_run`).

`drizzle-kit migrate` against a **fresh** database applies all 37 cleanly and
records them in `drizzle.__drizzle_migrations` — verified 2026-07-05:

```
$ DATABASE_DIRECT_URL=<fresh-db> pnpm --filter @hale/db migrate
[✓] migrations applied successfully!
$ DATABASE_DIRECT_URL=<fresh-db> pnpm --filter @hale/db drift-check
OK: database in sync — all 37 migration(s) applied.
```

So the `migrate` CI leg is fully functional for fresh databases — the earlier
"baseline missing" blocker no longer applies. (The root cause was that
`drizzle-kit generate` couldn't load the schema until `drizzle.config.ts` was
pointed at the compiled `dist/schema/index.js`; that fix is in place and
`generate`/`migrate` both work once `@hale/db` is built.)

> **The migrate leg is correct; the gap was purely operational.** Prod fell
> behind not because `migrate` was broken, but because it was never *run* — its
> `DATABASE_DIRECT_URL` secret was unset (see
> [Migration drift guard](#migration-drift-guard)).

### B2 — Workspace packages are not runtime-resolvable  ⛔

**Status:** confirmed by test (both in Docker and locally). The worker crashes
on boot:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/app/packages/types/src/event.js' imported from /app/packages/types/src/index.ts
```

**Root cause:** `@hale/types`, `@hale/db`, and `@hale/tools-contracts` declare
`"main"`/`"exports"` → `./src/index.ts`. At runtime Node resolves the workspace
import to **TypeScript source** (which it can't execute, and whose `./event.js`
ESM specifier has no emitted JS on that path). The packages **are** built
(`packages/types/dist/index.js`, `dist/event.js` exist) — they're just
mis-pointed.

**Fix (one line per package, owned by `packages/**`):** repoint `main`/`types`/
`exports` to `./dist/index.js` / `./dist/index.d.ts` (and the `./schema`,
`./client` subpath exports for `@hale/db`). The worker Docker image already
ships `dist/` for all three, so this alone makes the worker run.

This edit lives in `packages/**` and is owned by the packages maker — it was
**not** made here (infra scope). The Docker image **builds** correctly; the
crash is purely the package-entrypoint defect.

---

## Verification status

| Item | Verifiable now (no secrets) | Credential-gated |
|---|---|---|
| `infra/fly.toml` | TOML parses; correct non-HTTP poller shape (no `http_service`, `restart=always`, `yyz`) | `fly config validate` (needs `fly auth login`) |
| Worker Docker image | **Builds** end-to-end from repo root; fails loud without `DATABASE_URL` | Runtime needs B2 fixed + secrets |
| `apps/web/vercel.json` | Valid JSON; `yul1` pinned; crons defined | `vercel deploy --prod` (needs token + linked project) |
| Migration provisioning | `drizzle-kit migrate` applies all 37 migrations to a fresh DB and `drift-check` reports in sync (verified on the local Supabase DB) | Real prod run needs `DATABASE_DIRECT_URL` set (see guard) |
| Migration drift guard | `pnpm --filter @hale/db drift-check` / `status` — unit tests + run against local DB (behind, 12-behind incident shape, and in-sync all exercised) | Prod gate needs `DATABASE_DIRECT_URL` set |
| `.github/workflows/deploy.yml` | YAML valid; **actionlint clean (0 findings)**; secret-gating logic; drift verify wired into the `migrate` leg | Real run needs the GitHub secrets above |

Full command transcript: `.loop/evidence/deploy-setup.log`.
