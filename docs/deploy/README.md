# Hearth — Deployment Runbook

How Hearth ships to production: **Vercel** (web + marketing site) + **Fly.io
Toronto/yyz** (the agent worker) + **Supabase Toronto** (Postgres). All
residency-sensitive compute and data stay in Canada (CLAUDE.md hard rule #1:
PIPEDA + Quebec Law 25 + CASL).

> **Status:** deploy-READY config. The live deploy is **credential-gated** — no
> Fly auth, no Supabase project, no Vercel prod token are wired yet. Everything
> below is verifiable without secrets (config validity, Docker build, scratch-DB
> migration test); see [Verification status](#verification-status). **Two release
> blockers** must be cleared before a first production deploy can actually run —
> see [Release blockers](#release-blockers).

---

## Architecture

```
                      ┌──────────────────────────────────────────────┐
        parent's      │  VERCEL  (global edge; functions pinned yyz1) │
        browser ─────▶│                                              │
                      │  apps/web   (@hearth/web)   — app, API routes   │
                      │  apps/site  (@hearth/site)  — marketing site    │
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
                      │  apps/worker (@hearth/worker) — pg-boss consumer │
                      │  consumes: events.ingested, actions.approved,  │
                      │            memory.inference.due, digest.daily  │
                      │  calls: Anthropic, Langfuse, Postmark          │
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
| `POSTMARK_API_KEY` | Outbound email sends (executor) | Yes (any email action). |
| `POSTMARK_FROM_ADDRESS` | Verified sender | Yes (any email action). |
| `INTERNAL_API_SHARED_SECRET` | web↔worker internal auth | If used. |

### Vercel — web + site (Project → Settings → Environment Variables, Production)

| Secret | web | site | Purpose |
|---|:--:|:--:|---|
| `DATABASE_URL` | ✓ | — | Reads + enqueue |
| `DATABASE_DIRECT_URL` | ✓ | — | Build-time / non-pooled |
| `ANTHROPIC_API_KEY` | ✓ | — | If web does any inline LLM |
| `CLERK_SECRET_KEY` | ✓ | — | Auth |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | ✓ | — | Auth (public) |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` | ✓ | — | Tracing |
| `APP_URL` / `WORKER_URL` | ✓ | — | Cross-service URLs |
| (none app-specific) | — | ✓ | site is static marketing |

### GitHub Actions — CI/CD deploy (`Settings → Secrets → Actions`)

These drive `.github/workflows/deploy.yml`. **A leg whose secret is absent is
skipped with a notice; the pipeline stays green. A leg that runs without its
required secret fails loud.**

| Secret | Gates leg | Notes |
|---|---|---|
| `DATABASE_DIRECT_URL` | `migrate` | Direct (non-pooled) URL — drizzle-kit runs DDL in a transaction. |
| `VERCEL_TOKEN` | `vercel` | Deploy token. |
| `VERCEL_ORG_ID` | `vercel` | From `.vercel/project.json` after `vercel link`. |
| `VERCEL_PROJECT_ID_WEB` | `vercel` (web) | Web project id. |
| `VERCEL_PROJECT_ID_SITE` | `vercel` (site) | Site project id. |
| `FLY_API_TOKEN` | `fly` | `fly auth token`. |

---

## First-time provisioning

### 1. Supabase (Toronto)

1. Create a project in the Supabase dashboard, **region `ca-central-1`
   (Toronto)**. (`infra/supabase/config.toml` is the local emulator config.)
2. Grab the **pooled** connection string (port 6543, `?pgbouncer=true`) for
   `DATABASE_URL`, and the **direct** string (port 5432) for `DATABASE_DIRECT_URL`.
3. Provision the schema — **see [Release blockers](#release-blockers) first**.
   - **Interim / dev path (verified working):**
     ```bash
     pnpm --filter @hearth/db build           # drizzle.config reads dist/schema
     DATABASE_DIRECT_URL=<direct-url> pnpm --filter @hearth/db push   # drizzle-kit push
     ```
   - The intended CI path (`drizzle-kit migrate`) is **blocked** until the
     baseline migration exists (blocker B1).

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

- Web project uses `infra/vercel.json` (`--filter=@hearth/web`, output `apps/web/.next`).
- Site project uses `infra/vercel.site.json` (`--filter=@hearth/site`, output `apps/site/.next`).
- Both pin functions to `yyz1`.

### 3. Fly.io worker (Toronto)

```bash
fly launch --config infra/fly.toml --no-deploy   # creates the hearth-worker app, region yyz
fly secrets set \
  DATABASE_URL=... ANTHROPIC_API_KEY=... \
  LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... LANGFUSE_HOST=... \
  POSTMARK_API_KEY=... POSTMARK_FROM_ADDRESS=... \
  --app hearth-worker
fly deploy --config infra/fly.toml --remote-only
fly logs --app hearth-worker     # expect: "pg-boss started" → "consumers registered" → "Hearth worker ready"
```

The worker is a **non-HTTP** process (a pure pg-boss poller). `infra/fly.toml`
has no `[http_service]` and no HTTP health check — liveness is the Fly restart
policy (`policy = "always"`), and `min` machines is held at 1 so the queue is
always drained.

---

## Deploy flow (CI/CD)

`.github/workflows/deploy.yml` triggers on **CI success on `main`**
(`workflow_run`), then:

1. **preflight** — gates on CI success; resolves which legs have secrets.
2. **migrate** — `drizzle-kit migrate` against Supabase (skipped if no
   `DATABASE_DIRECT_URL`). Runs first; a failure blocks the deploys.
3. **vercel** (matrix: web + site) and **fly** (worker) run in parallel after a
   clean/skipped migrate.

Each leg self-asserts its required secret and `exit 1`s loud if invoked without
it.

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
fly releases --app hearth-worker                     # list versions
fly releases rollback <version> --app hearth-worker  # roll to a prior release image
# or: fly deploy --image <previous-image-ref> --app hearth-worker
```
The worker is stateless (state lives in Postgres), so rollback is just swapping
the image; in-flight jobs are retried by pg-boss.

### Database
Migrations are **additive only** (CLAUDE.md #9) — there is no automated
down-migration. To recover from a bad migration, restore via **Supabase
Point-in-Time Recovery** (Toronto region) to just before the migration.

---

## Release blockers

### B1 — Production migration baseline is missing  ⛔

**Status:** confirmed by test. `packages/db/drizzle/` contains only additive
deltas (`0000_b8910_reliability`, `0001_b18_entitlements`,
`0002_fixwave_a_execute_resume`) and **`meta/` has only `_journal.json` — no
`*_snapshot.json`**. No migration ever `CREATE`s the base tables/enums.

Running `drizzle-kit migrate` against an **empty** database fails immediately:

```
applying migrations...error: type "event_status" does not exist  (SQLSTATE 42704)
```

…because `0000` does `ALTER TYPE "event_status" ADD VALUE` on a type that was
never created. **A fresh Supabase cannot be provisioned from the current
migration set.**

**Root cause:** `drizzle-kit generate` originally couldn't load the schema (it
needs the compiled `dist/`, not `.ts` source with `.js` ESM specifiers), so no
baseline snapshot/migration was ever emitted; only hand-written additive deltas
exist.

**Fix (tested, owned by `packages/db`):** `drizzle.config.ts` now points at
`dist/schema/index.js`, and `generate` **works** once `@hearth/db` is built. The
fix is to regenerate a baseline-first migration set:

1. `pnpm --filter @hearth/db build`
2. Add a `0000_baseline` migration that `CREATE`s all 14 tables + 12 enums
   (`drizzle-kit generate` against an empty DB produces exactly this), and
   renumber the existing additive deltas after it.
3. The additive deltas keep their `IF NOT EXISTS` guards, so they are safe
   no-ops on a DB built from the baseline **and** still apply to the existing
   dev/prod DB.

**Verified:** a baseline-first set (`0000_baseline` + the three renumbered
deltas) applied cleanly to an empty DB via `drizzle-kit migrate` — 14 tables,
12 enums, 4 migrations recorded. The deltas were also confirmed idempotent on an
already-provisioned DB. (Evidence: `.loop/evidence/deploy-setup.log`, steps
4e–4j.)

This edit lives in `packages/db/**` and is owned by the db maker — it was **not**
made here (infra scope). Until it lands, provision Supabase with `drizzle-kit
push` (the interim path above) and the `migrate` CI leg should be treated as
not-yet-functional for fresh databases.

### B2 — Workspace packages are not runtime-resolvable  ⛔

**Status:** confirmed by test (both in Docker and locally). The worker crashes
on boot:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/app/packages/types/src/event.js' imported from /app/packages/types/src/index.ts
```

**Root cause:** `@hearth/types`, `@hearth/db`, and `@hearth/tools-contracts` declare
`"main"`/`"exports"` → `./src/index.ts`. At runtime Node resolves the workspace
import to **TypeScript source** (which it can't execute, and whose `./event.js`
ESM specifier has no emitted JS on that path). The packages **are** built
(`packages/types/dist/index.js`, `dist/event.js` exist) — they're just
mis-pointed.

**Fix (one line per package, owned by `packages/**`):** repoint `main`/`types`/
`exports` to `./dist/index.js` / `./dist/index.d.ts` (and the `./schema`,
`./client` subpath exports for `@hearth/db`). The worker Docker image already
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
| `infra/vercel.json` / `infra/vercel.site.json` | Valid JSON; CLI loads config + build command; `yyz1` pinned | `vercel build/deploy` (needs token + linked project) |
| Migration provisioning | `drizzle-kit push` → 14 tables/12 enums on scratch DB; baseline-first `migrate` proven | Real run needs Supabase + B1 fixed |
| `.github/workflows/deploy.yml` | YAML valid; **actionlint clean (0 findings)**; secret-gating logic | Real run needs the GitHub secrets above |

Full command transcript: `.loop/evidence/deploy-setup.log`.
