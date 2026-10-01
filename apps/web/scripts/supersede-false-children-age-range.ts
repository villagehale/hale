#!/usr/bin/env tsx
// One-off. Not imported by any cron, route, or startup path.
//
// Closes the live children_age_range fact the chat distiller wrote from an
// intake suggestion list (2026-10-01) for the family whose id starts with
// 2c939172. valid_until is set through forgetFamilyFact. A second run finds
// no live row and leaves the first close instant where it is.
//
//   DATABASE_URL=postgres://... pnpm --filter @hale/web supersede:false-children-age-range
//
// A non-local host is refused unless --i-mean-prod is passed. Do not point
// this at production unless that flag is a deliberate operator choice.

import { createDb } from '@hale/db';
import { supersedeFalseChildrenAgeRange } from '../lib/memory/supersede-false-children-age-range';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('supersede-false-children-age-range: DATABASE_URL is not set.');
  process.exit(1);
}

let host: string;
try {
  host = new URL(url).hostname;
} catch {
  console.error('supersede-false-children-age-range: DATABASE_URL is not a URL.');
  process.exit(1);
}
const isLocal = host === 'localhost' || host === '127.0.0.1';
if (!isLocal && !process.argv.includes('--i-mean-prod')) {
  console.error(
    `supersede-false-children-age-range: refusing non-local database host "${host}" without --i-mean-prod.`,
  );
  process.exit(1);
}

const database = createDb({ connectionString: url });
const result = await supersedeFalseChildrenAgeRange(database, { now: new Date() });
console.info(
  `supersede-false-children-age-range: matched=${result.matched} forgotten=${result.forgotten} alreadyClosed=${result.alreadyClosed} refused=${result.refused}`,
);
process.exit(0);
