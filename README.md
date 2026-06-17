# Hale

Passive, event-driven, multi-agent household AI assistant for families, across every stage of childhood (0–18). Hale ingests a family's data streams (email, calendar, photos), classifies events, drafts actions in the family's voice, verifies them through an independent reviewer agent, and executes routine work autonomously. Parents receive a daily digest of work done on their behalf.

**Status:** Foundation scaffold. See `docs/superpowers/specs/` for the design spec.

## Architecture

Two services sharing a Postgres database:

- **`apps/web`** — Next.js 15 app (UI + thin API + webhook receivers) → deployed to Vercel
- **`apps/worker`** — Long-running Node.js service (agent runtime + executors) → deployed to Fly.io YYZ Toronto
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
└── infra/                        Deployment configs (Vercel, Fly, Supabase)
```

## Development

Requires Node.js 22 LTS and pnpm 9+.

```bash
pnpm install
cp .env.example .env.local      # fill in secrets
pnpm db:migrate                 # run Drizzle migrations
pnpm dev                        # runs web + worker concurrently via Turbo
```

## Compliance posture

Built for Canadian launch. PIPEDA + Quebec Law 25 + CASL compliance from day one. Data residency in `ca-central-1`. See `docs/compliance/` for full details.

## License

Proprietary. © 2026 Hale Lab.
