#!/usr/bin/env tsx
// One-time scrub of the sender words email alerts stored on thread rows before VIL-619.
// Rewrites each `messages.source` that still carries `snippet` to ids plus `private`, which
// keeps a 13+ child's email refused by `read_email`. Prints counts only.
//
// It deletes data. Do not run --apply against prod without Barton's OK.
//
//   pnpm --filter @hale/web exec tsx scripts/scrub-email-alert-snippets.ts           # dry run
//   pnpm --filter @hale/web exec tsx scripts/scrub-email-alert-snippets.ts --apply   # write
//
// Needs DATABASE_URL.

import { createDb } from '@hale/db';
import { scrubEmailAlertSnippets } from '../lib/integrations/email-alert-snippet-scrub';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const database = createDb({ connectionString: url });
const summary = await scrubEmailAlertSnippets(database, {
  apply: process.argv.includes('--apply'),
});
console.info(JSON.stringify(summary, null, 2));
process.exit(0);
