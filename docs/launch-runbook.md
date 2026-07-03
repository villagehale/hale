# Launch / Ops Runbook

Hale is public (2026-06-27). This is the operational checklist for deploys, monitoring, and rollback.

## Post-deploy smoke test (run after any prod deploy)
1. **Landing** (villagehale.com): loads; "Join the village" → `app.villagehale.com/sign-in`.
2. **/sign-in**: shows "Continue with Google" **and** email + password.
3. **Email sign-up**: /sign-up → submit → "check your inbox" → verify link → can sign in.
4. **Google sign-up**: new Google account → onboarding → /home.
5. **Onboarding**: kids + coarse area + Free plan → reaches the app.
6. **Ask Hale**: a question returns a grounded answer (streams token-by-token); fever/teen questions stay rule-#1 safe.
7. **Village**: pins are local (geocoding bias); accept an activity → it appears in Approvals.

## Monitor
- **Spend** (the cost guard): the spend-alert cron + the Anthropic console. Rate-limiter caps coach 60/min/user, ingest 120/min/source.
- **Errors**: PostHog error tracking (exceptions + linked replay) — unhandled errors capture into the user's masked session, so each error opens to its replay.
- **Signups / activation**: PostHog funnels — *build the dashboards* (VIL-135); events are wired, autocapture off.
- **Rate-limit hits**: `rate_limits` table (over-cap rows = someone hit a wall).

## Rollback
- **Bad deploy**: `vercel rollback` on the `hale` project (or redeploy the prior good deployment URL). apps/site (marketing) redeploys from `main`.
- **Emergency re-close to invite-only**: set `BETA_INVITE_ONLY=true` (Vercel prod env) + redeploy `apps/web` → onboarding is gated again. (The Edge middleware inlines this at build, so a redeploy is required.)
- **Migrations are additive** (rule #9) — no destructive rollback. A bad migration is hand-reverted via `psql`. Note: prod migrations apply via `pnpm --filter @hale/db migrate` (tracking was backfilled — VIL-149); secrets are runtime-only, so auth pages must be `force-dynamic`.

## Auth
- Google OAuth + email/password (Auth.js Credentials, argon2id). `AUTH_SECRET` is runtime-only.
- Email verification required by default (`REQUIRE_EMAIL_VERIFICATION` — escape hatch only).

## One-off data corrections
- **Wrong activity "register / view details" links**: candidates discovered before the source-url fix stored the model-guessed url. Correct the persisted rows once (re-run until `updated` is 0 — each run is capped at 50): `DATABASE_URL=... GOOGLE_MAPS_API_KEY=... pnpm --filter @hale/web backfill:source-urls`. Hand-run only — `force` re-checks every candidate through Places, so it is deliberately not on the discovery cron.
