#!/usr/bin/env tsx
// The operator path for an opt-out hold no read can release: a collision hold (one provider
// id on two numbers), or a kind the code does not know. With no key it lists those holds by
// key and age. With --key and --apply it clears that one hold and writes the number's
// holders an audit row. Prints ids and counts only.
//
// It deletes data. Do not run --apply against prod without Barton's OK.
//
//   pnpm --filter @hale/web exec tsx scripts/clear-opt-out-collision-hold.ts                         # list
//   pnpm --filter @hale/web exec tsx scripts/clear-opt-out-collision-hold.ts --key <key> --apply     # clear
//
// Needs DATABASE_URL.

import { createDb, schema } from '@hale/db';
import { ne } from 'drizzle-orm';
import { MESSAGE_HOLD, clearCollisionHold } from '../lib/channel/intake/opt-out-hold';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const database = createDb({ connectionString: url });
const keyAt = process.argv.indexOf('--key');
const key = keyAt === -1 ? null : process.argv[keyAt + 1];

if (!key) {
  const holds = await database
    .select({
      key: schema.optOutHeldMessages.providerMessageId,
      heldAt: schema.optOutHeldMessages.heldAt,
    })
    .from(schema.optOutHeldMessages)
    .where(ne(schema.optOutHeldMessages.kind, MESSAGE_HOLD));
  console.info(
    JSON.stringify(
      { holds: holds.map((hold) => ({ key: hold.key, heldAt: hold.heldAt.toISOString() })) },
      null,
      2,
    ),
  );
} else if (!process.argv.includes('--apply')) {
  console.info(JSON.stringify({ key, outcome: 'dry_run' }));
} else {
  console.info(JSON.stringify({ key, outcome: await clearCollisionHold(database, key) }));
}
process.exit(0);
