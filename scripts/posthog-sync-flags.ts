#!/usr/bin/env npx tsx
/**
 * Create or update Hale launch flags in PostHog at 100% rollout.
 *
 *   pnpm --filter @hale/flags sync -- --dry
 *   pnpm --filter @hale/flags sync
 *
 * Needs POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID. Never creates
 * BROWSER_USE_SIGNUP_PAYMENT_ENABLED or LINQ_APP_CLIP_PAY_ENABLED.
 */
import { PAYMENT_ENV_ONLY, syncFlags } from '../packages/flags/src/index.ts';

const dry = process.argv.includes('--dry');

const result = await syncFlags({ dry });

console.warn(
  JSON.stringify(
    {
      dry: result.dry,
      familyGroupIndex: result.familyGroupIndex,
      skippedPayments: [...PAYMENT_ENV_ONLY.map((row) => row.env)],
      counts: {
        create: result.flags.filter((row) => row.action === 'create').length,
        update: result.flags.filter((row) => row.action === 'update').length,
        unchanged: result.flags.filter((row) => row.action === 'unchanged').length,
        wouldCreate: result.flags.filter((row) => row.action === 'would-create').length,
        wouldUpdate: result.flags.filter((row) => row.action === 'would-update').length,
      },
      flags: result.flags,
    },
    null,
    2,
  ),
);
