#!/usr/bin/env tsx
// The launch load probe for the Vercel drain (VIL-314), against a LOCAL Postgres only:
// Preview shares the production database, so a load test there is a load test on prod.
// It refuses any host but localhost. Output is counts and durations, never a payload.
//
// A throwaway cluster whose probe role has the pooler's 15 connections:
//
//   initdb -D "$DIR" -U postgres --auth=trust
//   pg_ctl -D "$DIR" -o "-p 54329 -c max_connections=40" -l "$DIR/log" start
//   psql -p 54329 -U postgres -c "CREATE ROLE probe LOGIN CONNECTION LIMIT 15" \
//        -c "CREATE DATABASE probe OWNER probe"
//
//   LOAD_PROBE_DATABASE_URL=postgres://probe@localhost:54329/probe \
//   LOAD_PROBE_ADMIN_URL=postgres://postgres@localhost:54329/probe \
//   pnpm --filter @hale/web probe:drain-load -- --families 100 --window-min 10
//
// Exit 0 when the drain's bar holds (every text answered once, drain delay p95 < 5 s);
// the answer bar (p95 < 60 s, model time included) is printed beside it.

import { parseArgs } from 'node:util';
import { TURN_DEADLINE_MS } from '../lib/channel/config';
import { buildProbePlan } from '../lib/cron/load-probe/plan';
import { judgeProbe, summarizeProbe } from '../lib/cron/load-probe/report';
import { runDrainLoadProbe } from '../lib/cron/load-probe/run';

const { values } = parseArgs({
  options: {
    families: { type: 'string', default: '100' },
    'window-min': { type: 'string', default: '10' },
    'texts-per-family': { type: 'string', default: '1' },
    'follow-up-gap-s': { type: 'string', default: '20' },
    'burst-share': { type: 'string', default: '0' },
    'burst-s': { type: 'string', default: '60' },
    'kick-delay-ms': { type: 'string', default: '300' },
    'turn-queries': { type: 'string', default: '12' },
    reserve: { type: 'string', default: '2' },
    kill: { type: 'string', default: '0' },
    'drain-out-min': { type: 'string', default: '6' },
    seed: { type: 'string', default: '314' },
  },
});

function int(name: keyof typeof values): number {
  const n = Number(values[name]);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`drain-load-probe: --${name} must be a non-negative number`);
    process.exit(2);
  }
  return n;
}

const connectionString = process.env.LOAD_PROBE_DATABASE_URL;
const adminConnectionString = process.env.LOAD_PROBE_ADMIN_URL;
if (!connectionString || !adminConnectionString) {
  console.error('drain-load-probe: set LOAD_PROBE_DATABASE_URL and LOAD_PROBE_ADMIN_URL');
  process.exit(2);
}

const plan = buildProbePlan({
  families: int('families'),
  windowMs: int('window-min') * 60_000,
  textsPerFamily: int('texts-per-family'),
  followUpGapMs: int('follow-up-gap-s') * 1_000,
  burstShare: int('burst-share'),
  burstMs: int('burst-s') * 1_000,
  turnCapMs: TURN_DEADLINE_MS,
  seed: int('seed'),
});

const { records, counters } = await runDrainLoadProbe({
  connectionString,
  adminConnectionString,
  plan,
  kickDelayMs: int('kick-delay-ms'),
  cronEveryMs: 60_000,
  drainOutMs: int('drain-out-min') * 60_000,
  turnQueries: int('turn-queries'),
  reserveConnections: int('reserve'),
  killFirstAttempts: int('kill'),
  log: console,
});

const report = summarizeProbe(records, counters);
const verdict = judgeProbe(report);
console.info(JSON.stringify({ report, verdict }, null, 2));
process.exit(verdict.drainPass ? 0 : 1);
