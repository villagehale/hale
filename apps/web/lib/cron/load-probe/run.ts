import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import postgres from 'postgres';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import type { ChannelMessageReceivedJob } from '~/lib/channel/inbound-route';
import {
  type DrainHandlers,
  drainBossConfig,
  drainBossFrom,
  drainHotQueues,
  isConnectionExhaustion,
} from '~/lib/cron/drain';
import { defaultKickedDrainTiming, runKickedDrain } from '~/lib/cron/kicked-drain';
import type { ProbeArrival } from './plan';
import type { ProbeCounters, ProbeTextRecord } from './report';

/**
 * The launch load probe's runner (VIL-314): replay a plan of inbound texts against a
 * LOCAL Postgres through the production drain — the same pg-boss options, the same
 * singleton claim, the same `drainHotQueues` loop and the same kicked-run body the route
 * runs — and record when each text was claimed and answered.
 *
 * WHAT IS REAL: pg-boss, the queue declarations and retry policy, the producer's send
 * (`sendChannelMessageReceived`), the claim (`drainBossFrom` → singleton-fetch), expiry,
 * the drain loop, and one fresh pg-boss per run, which is what a serverless invocation is.
 *
 * WHAT IS REPLAYED: the turn. Its model time is a sleep drawn from production's turn
 * times (plan.ts), and its database work is `turnQueries` short round trips. No model is
 * called; the probe measures the drain, not the coach.
 *
 * THE CONNECTION BUDGET is the database role's connection limit, which stands in for the
 * Supabase pooler's pool_size (15) that the drain's session clients and every function's
 * transaction clients share. Session-mode clients (the drain's pg-boss) hold their slot
 * while open, as they do on the pooler. Transaction-mode clients (the producer and the
 * turn's queries) hold one only while working, which a pool that drops idle connections
 * almost at once stands in for.
 */

/** Local only. The probe drops and rebuilds the queue schema it is pointed at. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class ProbeTargetRefused extends Error {
  override name = 'ProbeTargetRefused';
}

export function assertLocalProbeDatabase(connectionString: string): void {
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new ProbeTargetRefused('the probe database must be a postgres:// URL');
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new ProbeTargetRefused('the probe runs against a local Postgres only');
  }
}

export interface ProbeRunInput {
  /** The connection-limited probe role. */
  connectionString: string;
  /** A superuser on the same database: resets the schema and samples connections, on
   * the reserved slots outside the probe role's limit. */
  adminConnectionString: string;
  plan: readonly ProbeArrival[];
  /** Webhook answer → kicked run starting (the kick's request plus a warm start). */
  kickDelayMs: number;
  /** The scheduled drain's period. */
  cronEveryMs: number;
  /** How long past the last arrival to wait for stragglers before calling them dropped. */
  drainOutMs: number;
  /** Database round trips one turn makes, half before its model time and half after. */
  turnQueries: number;
  /** Connections other traffic holds for the whole run (crons, webhooks, Preview). */
  reserveConnections: number;
  /** Texts whose FIRST attempt dies mid-turn, as a killed invocation would. */
  killFirstAttempts: number;
  log: Pick<Console, 'info' | 'error'>;
}

export interface ProbeRunResult {
  records: ProbeTextRecord[];
  counters: ProbeCounters;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SAMPLE_EVERY_MS = 200;
/** A transaction-mode client gives its server connection back as soon as it is done. */
const TXN_IDLE_SECONDS = 0.1;

function notInProbe(queue: string) {
  return async () => {
    throw new Error(`load probe: ${queue} is not part of the probe`);
  };
}

export async function runDrainLoadProbe(input: ProbeRunInput): Promise<ProbeRunResult> {
  assertLocalProbeDatabase(input.connectionString);
  assertLocalProbeDatabase(input.adminConnectionString);

  const admin = postgres(input.adminConnectionString, { max: 2, onnotice: () => {} });
  const role = new URL(input.connectionString).username;
  await admin.unsafe('DROP SCHEMA IF EXISTS pgboss CASCADE');

  const counters: ProbeCounters = {
    runs: 0,
    exhaustedRuns: 0,
    failedRuns: 0,
    turnDbErrors: 0,
    redrivenAfterAnswer: 0,
    enqueueFailures: 0,
    peakConnections: 0,
  };
  const quiet: Pick<Console, 'info' | 'error'> = {
    info: () => {},
    error: (detail: unknown) => {
      const err = (detail as { err?: unknown } | undefined)?.err;
      if (err !== undefined && isConnectionExhaustion(err)) return;
      input.log.error(detail);
    },
  };

  const reserve = postgres(input.connectionString, { max: input.reserveConnections || 1 });
  if (input.reserveConnections > 0) {
    await Promise.all(
      Array.from({ length: input.reserveConnections }, () =>
        reserve.reserve().then((conn) => conn`SELECT 1`),
      ),
    );
  }

  const txn = postgres(input.connectionString, {
    max: 10,
    idle_timeout: TXN_IDLE_SECONDS,
    connection: { application_name: 'probe_txn' },
    onnotice: () => {},
  });
  const producer = new PgBoss({
    connectionString: input.connectionString,
    supervise: false,
    schedule: false,
    max: 3,
    idleTimeoutMillis: TXN_IDLE_SECONDS * 1000,
    application_name: 'probe_producer',
  } as PgBoss.ConstructorOptions);
  producer.on('error', () => {});
  await producer.start();
  const { sendChannelMessageReceived } = await import('~/lib/channel/inbound-deps');

  const records = new Map<string, ProbeTextRecord & { attempts: number }>();
  const startedAt = Date.now();
  const clock = () => Date.now() - startedAt;
  let killsLeft = input.killFirstAttempts;
  const forever = new Promise<never>(() => {});

  const turnDb = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      try {
        await txn`SELECT 1`;
      } catch (err) {
        counters.turnDbErrors += 1;
        throw err;
      }
    }
  };

  const handlers: DrainHandlers = {
    channelMessage: async (job: ChannelMessageReceivedJob) => {
      const record = records.get(job.channel_message_id);
      if (!record) throw new Error('load probe: a job the plan never sent');
      record.claimedAtMs ??= clock();
      record.attempts += 1;
      // The router's first gate (turn ledger): a turn already answered ends here, so a
      // redelivery after a run died between the answer and its job's completion sends
      // nothing. Two attempts running at once both pass it, which `answers` catches.
      if (record.answeredAtMs !== undefined) {
        counters.redrivenAfterAnswer += 1;
        return;
      }
      const before = Math.ceil(input.turnQueries / 2);
      await turnDb(before);
      if (record.attempts === 1 && killsLeft > 0) {
        killsLeft -= 1;
        await forever;
      }
      await sleep(record.turnMs);
      await turnDb(input.turnQueries - before);
      record.answers += 1;
      record.answeredAtMs ??= clock();
    },
    runOrchestrator: notInProbe('events.ingested'),
    executeApprovedAction: notInProbe('actions.approved'),
    rerank: notInProbe('village.rerank'),
    channelSend: notInProbe('channel.send'),
    channelSendDead: notInProbe('channel.send.dead'),
    // The probe's turns never fold a burst.
    foldedInto: async () => [],
    deepResearch: notInProbe('deep.research'),
    autonomyNotices: notInProbe('autonomy notices'),
  };

  /** One serverless invocation: its own pg-boss on production's options, then the loop. */
  const drainRun = async (queues?: readonly string[]) => {
    counters.runs += 1;
    const boss = new PgBoss(drainBossConfig(input.connectionString));
    boss.on('error', () => {});
    try {
      await boss.start();
      return await drainHotQueues(
        { boss: drainBossFrom(boss), handlers, log: quiet, now: () => Date.now() },
        queues ? { queues } : {},
      );
    } catch (err) {
      if (isConnectionExhaustion(err)) counters.exhaustedRuns += 1;
      else counters.failedRuns += 1;
      throw err;
    } finally {
      await boss.stop({ graceful: true }).catch(() => {});
    }
  };

  const sampler = setInterval(() => {
    admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = ${role}`
      .then(([row]) => {
        counters.peakConnections = Math.max(counters.peakConnections, row?.n ?? 0);
      })
      .catch(() => {});
  }, SAMPLE_EVERY_MS);
  const cron = setInterval(() => {
    drainRun().catch(() => {});
  }, input.cronEveryMs);

  const families = new Map<number, { familyId: string; parentUserId: string }>();
  const arrivals = input.plan.map(async (arrival) => {
    await sleep(arrival.atMs);
    let family = families.get(arrival.family);
    if (!family) {
      family = { familyId: randomUUID(), parentUserId: randomUUID() };
      families.set(arrival.family, family);
    }
    const channelMessageId = randomUUID();
    records.set(channelMessageId, {
      arrivedAtMs: clock(),
      turnMs: arrival.turnMs,
      answers: 0,
      attempts: 0,
    });
    // The webhook's own work: the inbound row and the enqueue, then the 202 and the kick.
    try {
      await txn`SELECT 1`;
      await sendChannelMessageReceived(producer as never, {
        family_id: family.familyId,
        parent_user_id: family.parentUserId,
        channel_message_id: channelMessageId,
        provider_message_id: `probe-${channelMessageId}`,
        received_at: new Date().toISOString(),
        in_group: false,
      });
    } catch {
      // In production the row stays unmarked and the queue-maintenance reconciler
      // re-drives it, up to ten minutes later. Here it stays unanswered.
      counters.enqueueFailures += 1;
      return;
    }
    await sleep(input.kickDelayMs);
    await runKickedDrain(INBOUND_TURN_QUEUES, {
      run: () => drainRun(INBOUND_TURN_QUEUES),
      log: quiet,
      ...defaultKickedDrainTiming,
    });
  });

  const lastAt = Math.max(0, ...input.plan.map((a) => a.atMs));
  const deadline = startedAt + lastAt + input.drainOutMs;
  await Promise.race([Promise.all(arrivals), sleep(deadline - Date.now())]);
  while (Date.now() < deadline) {
    const open = [...records.values()].filter((r) => r.answeredAtMs === undefined).length;
    if (records.size === input.plan.length && open === 0) break;
    await sleep(1_000);
  }

  clearInterval(cron);
  clearInterval(sampler);
  const result: ProbeRunResult = {
    records: [...records.values()].map(({ attempts: _attempts, ...record }) => record),
    counters,
  };
  await Promise.allSettled([
    producer.stop({ graceful: false, wait: false }),
    txn.end({ timeout: 1 }),
    reserve.end({ timeout: 1 }),
    admin.end({ timeout: 1 }),
  ]);
  return result;
}
