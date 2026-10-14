#!/usr/bin/env tsx
// VIL-407 live probe: how many Linq chat IDs the line holds, read-only. Prints counts
// only — never a chat id, a handle, a name or the key. Puts nothing on a phone.
//
// Secrets come only from the environment, never from a file this script reads:
//   LINQ_API_KEY=... [DATABASE_URL=...] \
//     pnpm --filter @hale/web probe:linq-capacity --env test|prod
//
// `--env` labels every line (key=<env> db=<env>); the script cannot tell a test key
// from a prod key, so the operator says which one it was given. With DATABASE_URL it
// also prints the DB's count (countDbChatIds), which undercounts by design: parents
// mid-intake and erased families. Exits nonzero when Linq cannot be counted.

import { createDb } from '@hale/db';
import { listLinqChatsPage } from '../lib/channel/linq/transport';
import {
  LINQ_CHAT_ID_LIMIT,
  countDbChatIds,
  countLinqChats,
} from '../lib/monitoring/linq-capacity';

const PROBE_ENVS = ['test', 'prod'] as const;
const envArg = process.argv[process.argv.indexOf('--env') + 1];
const env = PROBE_ENVS.find((e) => e === envArg);
if (!process.argv.includes('--env') || !env) {
  console.error('usage: probe:linq-capacity --env test|prod');
  process.exit(1);
}
const label = `key=${env} db=${env}`;

const result = await countLinqChats({ listPage: listLinqChatsPage });
if (result.status === 'ok') {
  const { total, direct, groups, byService, pages } = result.count;
  console.log(
    `${label} linq total=${total} of ${LINQ_CHAT_ID_LIMIT} direct=${direct} groups=${groups} byService=${JSON.stringify(byService)} pages=${pages}`,
  );
} else {
  console.log(`${label} linq unavailable=${JSON.stringify(result)}`);
}

const url = process.env.DATABASE_URL;
if (url) {
  const database = createDb({ connectionString: url });
  console.log(`${label} db chatIds=${await countDbChatIds(database)} of ${LINQ_CHAT_ID_LIMIT}`);
}
process.exit(result.status === 'ok' ? 0 : 1);
