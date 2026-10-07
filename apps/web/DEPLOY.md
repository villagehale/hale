# hale-web — deployment notes

`hale-web` (app.villagehale.com) deploys from `main` via Vercel's native GitHub
integration. The production build runs `vercel-production-migrate.mjs` before
the Next.js build. That script applies Drizzle migrations and then checks that
every journal file hash is in `drizzle.__drizzle_migrations`. The deployment is
aliased only after the build exits 0, so a missing column cannot ship. The
database URL is the Vercel Production env var `DATABASE_DIRECT_URL` (Supabase
direct, port 5432) — the same name as the GitHub Actions secret. If it is unset,
the production build fails. Preview builds do not connect.

The Deploy workflow's `migrate` leg runs the same apply-and-check
(`pnpm --filter @hale/db migrate:guard`, then `pnpm db:check-migrations`) after
CI on `main`, and fails the workflow if `DATABASE_DIRECT_URL` is unset. It is
not the web promotion gate: Vercel does not wait for CI, and a cancelled CI run
used to skip migrations entirely. There is no separate worker deploy in that
workflow.

Incident (2026-07-05): the Vercel trigger for this project stopped firing after
Jul 2, so ~a dozen merges never deployed and prod served stale code (Village
cadence/search + Settings routes 404'd because their columns/routes weren't
live). Fixed by reconnecting the Git integration + re-arming migrations.
