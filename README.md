# Hale

Passive, event-driven, multi-agent household AI assistant for families, across every stage of childhood (0–18). Hale ingests a family's data streams (email, calendar, photos), classifies events, drafts actions in the family's voice, verifies them through an independent reviewer agent, and executes routine work autonomously. Parents receive a daily digest of work done on their behalf.

**Status:** Foundation scaffold. See `docs/superpowers/specs/` for the design spec.

## Architecture

The web app and the worker package share a Postgres database. The worker package is library code the Vercel drain imports:

- **`apps/web`** — Next.js 15 app (UI + thin API + webhook receivers) → deployed to Vercel
- **`apps/worker`** — Agent runtime + executors, imported by the Vercel `/api/cron/drain` function (yul1)
- **Postgres** — Supabase Toronto region

Agent runtime is **Claude Agent SDK** with 5 specialized agents (Classifier, Drafter, Coach, Reviewer, Memory Inferencer) and 3 deterministic services (Orchestrator, Memory Writer, Executor).

## Repository layout

```
hale/
├── apps/
│   ├── web/                      Next.js app
│   └── worker/                   Agent Worker service
├── packages/
│   ├── db/                       Drizzle schema + migrations
│   ├── types/                    Shared TypeScript types
│   ├── memory/                   Family memory graph helpers
│   ├── compliance/               PIPEDA / Law 25 audit helpers
│   └── tools-contracts/          Tool I/O schemas (Zod)
├── docs/
│   ├── superpowers/specs/        Design docs
│   ├── architecture/             ADRs
│   └── compliance/               PIA documents
└── infra/                        Deployment configs (Vercel, Supabase)
```

## Development

Requires Node.js 22 LTS and pnpm 9+.

```bash
pnpm install
cp .env.example .env.local      # fill in secrets
pnpm db:migrate                 # run Drizzle migrations
pnpm db:check-migrations        # exit non-zero if the journal has unapplied hashes
pnpm dev                        # runs the web app via Turbo
```

## Compliance posture

Built for Canadian launch. PIPEDA + Quebec Law 25 + CASL compliance from day one. Data residency in `ca-central-1`. See `docs/compliance/` for full details.

## iMessage year retention (ENG-1)

Onboarding stays free. A later iMessage ask — off unless `IMESSAGE_UPGRADE_ASK=on` — offers keeping Hale for the year. Yes sends a Stripe Payment Link or Checkout Session URL with `client_reference_id` set to the family id. `POST /api/webhooks/stripe` verifies the signature and writes `families.plan_tier` plus the Stripe customer and subscription ids.

Sandbox first. The variables are in `.env.example` (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price ids, and the optional Payment Link id). Placeholder ask copy lives in `apps/web/lib/billing/upgrade-copy.ts`.

```bash
pnpm --filter @hale/web test -- \
  lib/billing/upgrade-ask.test.ts \
  lib/billing/upgrade-ask.pglite.test.ts \
  lib/billing/stripe-client.test.ts \
  lib/webhooks/stripe-billing.test.ts \
  lib/webhooks/stripe-billing-apply.test.ts
```

No live Stripe call. The flag defaults off, so a normal inbound reply does not ask.

## License

Proprietary. © 2026 Hale Lab.
