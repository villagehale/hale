#!/usr/bin/env tsx
/**
 * Re-enqueue events the hard ceiling dropped for one family.
 *
 * Drops wrote `event.dropped.spend_ceiling` and completed the pg-boss job.
 * They did not fail, and they did not leave an events row, so a failed-job
 * retry cannot see them. This reads completed `events.ingested` rows from
 * pgboss.job and pgboss.archive inside that audit window, skips any job that
 * already became an events row, and prints job id plus source. Payload bodies
 * are not printed.
 *
 * Dry-run unless `--apply`. Not scheduled, not imported by the worker or a
 * cron. A second `--apply` can enqueue the same job again; the orchestrator
 * dedups once an events row exists.
 *
 * Drops that entered through the synchronous web ingest door never had a queue
 * job. This script cannot reconstruct those.
 *
 *   DATABASE_URL=... pnpm --filter @hale/worker replay:spend-ceiling <family-uuid>
 *   DATABASE_URL=... pnpm --filter @hale/worker replay:spend-ceiling <family-uuid> --apply
 */

import PgBoss from 'pg-boss';
import postgres from 'postgres';
import {
  EVENTS_INGESTED_QUEUE,
  REPLAY_EXPIRE_IN_SECONDS,
  SPEND_CEILING_DROP_VERB,
  replayCandidateLines,
  replayWindow,
  selectReplayCandidates,
  type ReplayJobRow,
  type ReplayStoredEvent,
} from '../src/services/replay-spend-ceiling.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usage(): never {
  console.error(
    'usage: replay:spend-ceiling <family-uuid> [--apply]\n' +
      '  dry-run unless --apply. Reads DATABASE_URL. Does not print payloads.',
  );
  process.exit(1);
}

interface JobSqlRow {
  id: string;
  data: unknown;
  completed_on: Date | string | null;
}

function completedOn(value: Date | string | null): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function isMissingRelation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = String(err.code);
  return code === '42P01' || code === '3F000';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter((arg) => arg !== '--apply');
  const familyId = positional[0];
  if (!familyId || positional.length !== 1 || !UUID.test(familyId)) usage();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1 });
  try {
    const audits = await sql<{ occurred_at: Date }[]>`
      SELECT occurred_at
      FROM audit_log
      WHERE family_id = ${familyId}::uuid
        AND action_taken = ${SPEND_CEILING_DROP_VERB}
    `;
    const window = replayWindow(audits.map((row) => ({ occurredAt: row.occurred_at })));
    if (!window) {
      console.info(
        `family ${familyId}: no ${SPEND_CEILING_DROP_VERB} audits. Nothing to replay.`,
      );
      console.info(
        'Drops that never entered the queue (the synchronous ingest door) have no job to replay.',
      );
      return;
    }

    const stored = await sql<{ source: string; dedup_hash: string; payload: unknown }[]>`
      SELECT source, dedup_hash, payload
      FROM events
      WHERE family_id = ${familyId}::uuid
    `;
    const storedEvents: ReplayStoredEvent[] = stored.map((row) => ({
      source: row.source,
      dedupHash: row.dedup_hash,
      payload: row.payload,
    }));

    const readJobs = async (table: 'pgboss.job' | 'pgboss.archive') => {
      if (table === 'pgboss.job') {
        return sql<JobSqlRow[]>`
          SELECT id::text AS id, data, completed_on
          FROM pgboss.job
          WHERE name = ${EVENTS_INGESTED_QUEUE}
            AND state = 'completed'
            AND data->>'family_id' = ${familyId}
            AND completed_on >= ${window.start}
            AND completed_on <= ${window.end}
        `;
      }
      return sql<JobSqlRow[]>`
        SELECT id::text AS id, data, completed_on
        FROM pgboss.archive
        WHERE name = ${EVENTS_INGESTED_QUEUE}
          AND state = 'completed'
          AND data->>'family_id' = ${familyId}
          AND completed_on >= ${window.start}
          AND completed_on <= ${window.end}
      `;
    };

    let archiveMissing = false;
    let jobRows: JobSqlRow[] = [];
    try {
      jobRows = await readJobs('pgboss.job');
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
      throw new Error('pgboss.job is not readable. Nothing enqueued.');
    }
    let archiveRows: JobSqlRow[] = [];
    try {
      archiveRows = await readJobs('pgboss.archive');
    } catch (err) {
      if (!isMissingRelation(err)) throw err;
      archiveMissing = true;
    }

    const jobs: ReplayJobRow[] = [];
    for (const row of [...jobRows, ...archiveRows]) {
      const at = completedOn(row.completed_on);
      if (!at) continue;
      jobs.push({ id: row.id, completedOn: at, data: row.data });
    }

    const selection = selectReplayCandidates({
      familyId,
      audits: audits.map((row) => ({ occurredAt: row.occurred_at })),
      jobs,
      storedEvents,
    });

    console.info(`family ${familyId}`);
    console.info(`audits ${audits.length}`);
    console.info(`window ${window.start.toISOString()} .. ${window.end.toISOString()}`);
    if (archiveMissing) console.info('pgboss.archive is absent; replay read pgboss.job only');
    console.info(`candidates ${selection.candidates.length}`);
    console.info(`already recorded ${selection.alreadyRecorded}`);
    console.info(`unreadable ${selection.unreadable}`);
    console.info(`outside window ${selection.outsideWindow}`);
    for (const line of replayCandidateLines(selection.candidates)) console.info(line);

    if (!apply) {
      console.info('dry-run. Pass --apply to enqueue.');
      return;
    }
    if (selection.candidates.length === 0) {
      console.info('nothing to enqueue.');
      return;
    }

    console.info(
      'A second --apply can enqueue the same job again. The orchestrator dedups once an events row exists.',
    );
    const boss = new PgBoss({ connectionString: url, schema: 'pgboss' });
    await boss.start();
    try {
      for (const candidate of selection.candidates) {
        const queued = await boss.send(EVENTS_INGESTED_QUEUE, candidate.data, {
          expireInSeconds: REPLAY_EXPIRE_IN_SECONDS,
        });
        if (!queued) {
          console.info(`queue did not accept ${candidate.id} ${candidate.source}`);
          continue;
        }
        console.info(`enqueued ${candidate.id} ${candidate.source} as ${queued}`);
      }
    } finally {
      await boss.stop({ graceful: true });
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : 'replay failed';
  console.error(message);
  process.exit(1);
});
