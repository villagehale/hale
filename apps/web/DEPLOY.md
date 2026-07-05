# hale-web — deployment notes

`hale-web` (app.villagehale.com) deploys from `main` via Vercel's native GitHub
integration. Migrations do NOT run on Vercel — they run via the `deploy.yml`
`migrate` leg, gated on the `DATABASE_DIRECT_URL` GitHub Actions secret. A
read-only drift-guard (`packages/db` `drift-check`) fails the deploy loudly if
prod is behind, so schema drift can't silently accumulate.

Incident (2026-07-05): the Vercel trigger for this project stopped firing after
Jul 2, so ~a dozen merges never deployed and prod served stale code (Village
cadence/search + Settings routes 404'd because their columns/routes weren't
live). Fixed by reconnecting the Git integration + re-arming migrations.
