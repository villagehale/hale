# Hale — Deployment Runbook

How Hale ships to production: **Vercel** (`hale-web` for the app, plus the
marketing site) and **Supabase Toronto** (Postgres). Scheduled work runs as
Vercel Cron jobs hitting `/api/cron/*` on `hale-web`. There is no separate
production worker host. All residency-sensitive compute and data stay in Canada
(CLAUDE.md hard rule #1: PIPEDA + Quebec Law 25 + CASL).

> **Status:** deploy-READY config. The live deploy is **credential-gated** — no
> Supabase project, no Vercel prod token are wired yet. Everything
> below is verifiable without secrets (config validity, scratch-DB migration
> test); see [Verification status](#verification-status). See
> [Release blockers](#release-blockers) for historical provisioning blockers (B1
> migration baseline and B2 package entrypoints — both now resolved).

---

## Architecture

```
                      ┌──────────────────────────────────────────────┐
        parent's      │  VERCEL  (hale-web + marketing site)          │
        browser ─────▶│  functions pinned yul1 (Montreal)             │
                      │                                              │
                      │  apps/web   (@hale/web)   — app, API routes   │
                      │  apps/web   /api/cron/*   — scheduled agents  │
                      │  apps/site  (@hale/site)  — marketing site    │
                      └───────────────┬──────────────────────────────┘
                                      │  Drizzle reads and writes
                                      │  Vercel Cron → /api/cron/*
                                      ▼
                      ┌──────────────────────────────────────────────┐
                      │  SUPABASE  Postgres 16  — ca-central-1 (yyz)  │
                      │  app tables + pgboss schema (the job queue)   │
                      └──────────────────────────────────────────────┘
```

**Production compute is `hale-web`.** The app and the `/api/cron/*` handlers
run on Vercel. Cron routes read and write Supabase, including the pg-boss
schema (`/api/cron/drain` and `/api/cron/queue-maintenance` keep that queue
moving). `apps/worker` is the library those routes import. It is not a
separate process or a production host.

### Data-residency rationale

| Concern | Placement | Why |
|---|---|---|
| Newborn data at rest | Supabase **ca-central-1 (Toronto)** | PIPEDA / Law 25 — data must not leave Canada. |
| Agent compute over that data | Vercel functions on **hale-web**, region **`yul1` (Montreal)** | Cron routes and request handlers run the agent harness in Canada. `apps/web/vercel.json` sets `regions: ["yul1"]`. |
| Web layer (Vercel) | **Global edge**, functions pinned `yul1` | The CDN/edge is global. Serverless functions, including `/api/cron/*`, are pinned to Montreal. The residency guarantee rests on Supabase (Toronto) plus that Canadian function region. |
| Object storage | Supabase Storage ca-central-1 | Same residency rule as Postgres. |

---

## Required secrets matrix

Names only — never commit values. `.env.example` is the source of truth for the
full app env; the table below is the **deploy-time** subset per platform.

### Vercel — web + site (Project → Settings → Environment Variables, Production)

| Secret | web | site | Purpose |
|---|:--:|:--:|---|
| `DATABASE_URL` | ✓ | — | Reads + enqueue |
| `DATABASE_DIRECT_URL` | ✓ | — | Build-time / non-pooled |
| `ANTHROPIC_API_KEY` | ✓ | — | Web agent pipeline + scheduled cron agents (digest / inference) |
| `AI_GATEWAY_API_KEY` | ✓ | — | Only when a VIL-376 JEV or DeepSeek candidate is enabled. |
| `RESEND_API_KEY` | ✓ | — | Daily-digest email send (from `hello@villagehale.com`; `RESEND_FROM` optional override) |
| `CRON_SECRET` | ✓ | — | **Required for the scheduled agents.** Vercel sends it as `Authorization: Bearer <CRON_SECRET>`; the cron routes 401 (do no work, no spend) without a match. See [Scheduled agents (cron)](#scheduled-agents-cron). |
| `CLERK_SECRET_KEY` | ✓ | — | Auth |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✓ | — | Auth (public) |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` | ✓ | — | Tracing |
| `APP_URL` | ✓ | — | Public app origin |
| (none app-specific) | — | ✓ | site is static marketing |

### GitHub Actions — CI/CD deploy (`Settings → Secrets → Actions`)

These drive `.github/workflows/deploy.yml` (which has one leg, `migrate`;
Vercel deploys `hale-web`, its `/api/cron/*` handlers, and the marketing site
via its own native integration, not here). The hale-web production build also
applies migrations before the deployment is aliased.

**`DATABASE_DIRECT_URL` absent fails the workflow.** A leg that runs without
its required secret fails loud.

| Secret | Gates leg | Notes |
|---|---|---|
| `DATABASE_DIRECT_URL` | `migrate` (and the hale-web production build) | Supabase direct (port 5432) URL. Unset fails Deploy preflight and fails the Vercel production build. See [Migration drift guard](#migration-drift-guard). |

---

## VIL-376 model rollout and kill switches

Every switch defaults to `current`; an empty value also means `current`. Set one switch to
`candidate` only after that slice is approved.

| Decision slice | Environment | `current` | `candidate` |
|---|---|---|---|
| Intake reply intent | `HALE_REPLY_INTENT_MODEL_MODE` on Vercel web | Sonnet 5 | JEV |
| Sentinel envelope triage | `HALE_TRIAGE_MODEL_MODE` on Vercel web | Haiku 4.5 | JEV |
| Event classification | `HALE_CLASSIFY_EVENT_MODEL_MODE` on Vercel web | Sonnet 5 | Sonnet 5.5 |
| Intake extraction | `HALE_INTAKE_EXTRACT_MODEL_MODE` on Vercel web | Sonnet 5 | Sonnet 5.5 |
| Inbound screen | `HALE_INBOUND_SCREEN_MODEL_MODE` on Vercel web | Haiku 4.5 | JEV |
| Memory inference | `HALE_MEMORY_INFER_MODEL_MODE` on Vercel web | Sonnet 4.6 | DeepSeek V4.1 Flash |
| Village search parsing | `HALE_VILLAGE_SEARCH_PARSE_MODEL_MODE` on Vercel web | Sonnet 5 | DeepSeek V4.1 Flash |

These switches affect internal decisions only. Parent-facing `converse`, `draft`, `answer`,
`acknowledge`, and `speak` output remains on its current Sonnet/Haiku routing.

Deploying this code keeps every current model unless a flag explicitly says `candidate`.
Rollback is setting the affected flag to `current` and redeploying/restarting the web service.
JEV and DeepSeek require `AI_GATEWAY_API_KEY`. Candidate failures retry the current model
except memory inference, whose tool loop is not retried because that could duplicate writes.

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
   In production the hale-web build applies this before the deployment is
   aliased, and the Deploy `migrate` leg applies it again
   (`pnpm --filter @hale/db migrate:guard`, then `pnpm db:check-migrations`)
   once `DATABASE_DIRECT_URL` is set
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
the `@hale/agent` harness. Worker code runs inside `/api/cron/drain` (yul1).
The schedule lives in `apps/web/vercel.json` under
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

### 3. Scheduled work (no separate worker)

Production does not deploy `apps/worker`. The schedule is the `crons` array in
`apps/web/vercel.json`; the handlers are `apps/web/app/api/cron/*`. Set
`CRON_SECRET` on the hale-web Production environment (see
[Scheduled agents (cron)](#scheduled-agents-cron)). `apps/worker` stays in the
repo as the library `/api/cron/drain` imports. It is not a separate deploy.

---

## Deploy flow (CI/CD)

There are **two independent delivery paths** — this is the crucial topology to
understand:

1. **Web + marketing site → Vercel, via the native GitHub integration.** `hale-web`
   and `site` are GitHub-connected Vercel projects; `vercel[bot]` builds a
   Production deployment on every `main` merge. The hale-web **production build
   applies migrations before the deployment can be aliased**
   (`packages/db/scripts/vercel-production-migrate.mjs`). A failed migrate or a
   failed hash check fails the build, and the previous production deployment
   keeps serving. Preview builds do not connect. `site` has no schema.
2. **DB migrations → `.github/workflows/deploy.yml`**, triggered on **CI
   success on `main`** (`workflow_run`):
   - **preflight** — gates on CI success. `DATABASE_DIRECT_URL` **absent fails
     the workflow** (it used to skip, and the pipeline stayed green).
   - **migrate** — `pnpm --filter @hale/db migrate:guard` (advisory lock, drizzle
     migrate, hash check) against Supabase, then `pnpm db:check-migrations`.

   This workflow is not the web promotion gate. Vercel does not wait for CI, and
   a cancelled CI run skips the workflow. The production build is what stops a
   new hale-web deployment from taking traffic while migrations are unapplied.
   There is no worker deploy in this workflow. Scheduled agents ship with the
   `hale-web` Vercel deployment (`/api/cron/*`).

> The web build and this workflow both use `DATABASE_DIRECT_URL` (Supabase
> direct, port 5432). See [Migration drift guard](#migration-drift-guard).

---

## Migration drift guard

**The secret both gates already use:** `DATABASE_DIRECT_URL`, the Supabase
**direct** (port 5432, non-pooled) connection string.

- **GitHub Actions** — repository secret (or the `production` environment).
  Preflight fails the Deploy workflow if it is unset.
- **Vercel hale-web** — Production environment variable, available at **build**
  time (an encrypted variable is; a Sensitive variable is not). The production
  build fails before alias if it is unset.

No second secret name. If either copy is removed, that side fails closed and
the log names `DATABASE_DIRECT_URL`.

Once set, both paths:

- **Apply** — drizzle's migrator applies every journal entry whose `when` is
  greater than `max(created_at)` in `drizzle.__drizzle_migrations`.
- **Check** — `pnpm db:check-migrations` compares each journal file's sha256 to
  `__drizzle_migrations.hash` and **exits non-zero, listing every unrecorded
  file**. A watermark-only "in sync" is not success: drizzle will not apply a
  file whose `when` is already covered, so the hash check fails the build
  instead of shipping the code. Documented gaps live in
  `packages/db/scripts/ledger-exemptions.json`. A missing hash is accepted only
  when that file's `when` is already a `created_at`, when `supersededBy` names
  a later migration whose hash is in the ledger, or when a schema entry's
  column (and index, when named) is present. None of those is a blanket skip.

### The incident this prevents

On **2026-06-14**, prod's schema drifted **12 migrations behind for ~3 weeks**
and nobody noticed. The Village cadence feature was broken in prod because the
`cadence` / `superseded_at` columns (migration `0027_village_cadence`) never
existed there.

**Root cause:** migrations were never auto-applied. The web deployed via Vercel's
native integration, which did not run migrations, and the `deploy.yml` `migrate`
leg was **skipped on every run** because `DATABASE_DIRECT_URL` had never been set
as a GitHub secret. So there was no path that applied pending migrations to prod,
and nothing that alarmed when prod fell behind.

**How the guard prevents recurrence:** the hale-web production build applies
migrations and runs the hash check before Vercel can alias the deployment, so a
cancelled CI run (which skips this workflow — what left `0150` unapplied on
2026-10-02) no longer promotes code first. A missing `DATABASE_DIRECT_URL`
fails that build and fails this workflow instead of skipping. A human can run
the same check locally at any time:

```bash
DATABASE_DIRECT_URL=<direct-url> pnpm db:check-migrations   # exit 1 if any journal hash is missing
DATABASE_DIRECT_URL=<direct-url> pnpm --filter @hale/db status
```

`pnpm db:check-migrations` with neither URL set exits 1 and names
`DATABASE_DIRECT_URL`. It does not print the connection string.

---

## Rollback

### Vercel
```bash
vercel ls <project> --token=$VERCEL_TOKEN          # list deployments, find last-good prod URL
vercel promote <previous-prod-url> --token=$VERCEL_TOKEN
```
`promote` re-points the production domain to a prior deployment (no rebuild).
That rolls back `hale-web` and its `/api/cron/*` handlers together. There is no
separate worker image to roll back; queue state lives in Supabase.

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

**Status:** historical. The Fly worker image this note describes has been
removed. The live path is Vercel `/api/cron/drain` (yul1), which transpiles the
workspace packages. The crash below was the deleted image booting `node
dist/index.js`:

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
`./client` subpath exports for `@hale/db`).

This edit lives in `packages/**` and is owned by the packages maker — it was
**not** made here (infra scope). The crash was the package-entrypoint defect
on the removed image. The Vercel drain does not boot that image.

---

## Verification status

| Item | Verifiable now (no secrets) | Credential-gated |
|---|---|---|
| Fly worker (`infra/fly.toml`, `apps/worker/Dockerfile`) | Removed. Production never deployed it. Worker code runs inside Vercel `/api/cron/drain` (yul1). | — |
| `apps/web/vercel.json` | Valid JSON; `yul1` pinned; crons defined | `vercel deploy --prod` (needs token + linked project) |
| Migration provisioning | `drizzle-kit migrate` applies all 37 migrations to a fresh DB and `drift-check` reports in sync (verified on the local Supabase DB) | Real prod run needs `DATABASE_DIRECT_URL` set (see guard) |
| Migration ledger guard | `pnpm db:check-migrations` — hash comparison; unit tests cover a missing table, a watermark-skipped file, and the historical exemptions | Prod gate needs `DATABASE_DIRECT_URL` set on Vercel Production and in GitHub Actions |
| `.github/workflows/deploy.yml` | YAML valid; **actionlint clean (0 findings)**; secret-gating logic; drift verify wired into the `migrate` leg | Real run needs the GitHub secrets above |

Full command transcript: `.loop/evidence/deploy-setup.log`.
