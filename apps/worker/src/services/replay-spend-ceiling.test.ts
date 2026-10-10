import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REPLAY_EXPIRE_IN_SECONDS,
  REPLAY_WINDOW_BUFFER_MS,
  canonicalJson,
  replayCandidateLines,
  replayWindow,
  selectReplayCandidates,
  type ReplayJobRow,
  type ReplayStoredEvent,
} from './replay-spend-ceiling.js';

const FAMILY = '2c939172-1111-4111-8111-111111111111';
const DROPPED_AT = new Date('2026-09-30T18:00:00.000Z');

function payload(body: Record<string, unknown>) {
  return {
    family_id: FAMILY,
    source: 'gcal',
    payload: body,
    received_at: '2026-09-30T17:59:00.000Z',
  };
}

function job(id: string, completedOn: Date, data: unknown): ReplayJobRow {
  return { id, completedOn, data };
}

describe('replayWindow', () => {
  it('is empty when the family has no spend-ceiling drop audits', () => {
    expect(replayWindow([])).toBeNull();
  });

  it('runs from the earliest audit to 30s after the latest', () => {
    const later = new Date(DROPPED_AT.getTime() + 60_000);
    const window = replayWindow([{ occurredAt: later }, { occurredAt: DROPPED_AT }]);
    expect(window?.start).toEqual(DROPPED_AT);
    expect(window?.end.getTime()).toBe(later.getTime() + REPLAY_WINDOW_BUFFER_MS);
  });
});

describe('selectReplayCandidates', () => {
  const secret = { summary: 'secret-body', start: { dateTime: '2026-09-01T15:00:00Z' } };

  it('returns nothing when there are no drop audits', () => {
    const selection = selectReplayCandidates({
      familyId: FAMILY,
      audits: [],
      jobs: [job('job-1', DROPPED_AT, payload(secret))],
      storedEvents: [],
    });
    expect(selection.candidates).toEqual([]);
  });

  it('keeps a completed job inside the window that never became an event', () => {
    const selection = selectReplayCandidates({
      familyId: FAMILY,
      audits: [{ occurredAt: DROPPED_AT }],
      jobs: [job('job-1', new Date(DROPPED_AT.getTime() + 10_000), payload(secret))],
      storedEvents: [],
    });
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual(['job-1']);
    expect(replayCandidateLines(selection.candidates)).toEqual(['job-1 gcal']);
    expect(replayCandidateLines(selection.candidates).join('\n')).not.toContain('secret-body');
  });

  it('drops a job completed after the 30s buffer', () => {
    const selection = selectReplayCandidates({
      familyId: FAMILY,
      audits: [{ occurredAt: DROPPED_AT }],
      jobs: [
        job('late', new Date(DROPPED_AT.getTime() + REPLAY_WINDOW_BUFFER_MS + 1), payload(secret)),
      ],
      storedEvents: [],
    });
    expect(selection.candidates).toEqual([]);
    expect(selection.outsideWindow).toBe(1);
  });

  it('excludes a job whose dedup hash already matches an events row', () => {
    const body = { a: 1, b: 2 };
    const raw = JSON.stringify(body);
    const hash = createHash('sha256').update(`${FAMILY}|gcal|${raw}`).digest('hex');
    const stored: ReplayStoredEvent = { source: 'gcal', dedupHash: hash, payload: { other: true } };
    const selection = selectReplayCandidates({
      familyId: FAMILY,
      audits: [{ occurredAt: DROPPED_AT }],
      jobs: [job('hashed', DROPPED_AT, payload(body))],
      storedEvents: [stored],
    });
    expect(selection.candidates).toEqual([]);
    expect(selection.alreadyRecorded).toBe(1);
  });

  it('excludes a job when jsonb key order differs but the payload is the same', () => {
    const stored: ReplayStoredEvent = {
      source: 'gcal',
      dedupHash: 'not-the-original-order',
      payload: { a: 2, z: 1 },
    };
    const selection = selectReplayCandidates({
      familyId: FAMILY,
      audits: [{ occurredAt: DROPPED_AT }],
      jobs: [job('reordered', DROPPED_AT, payload({ z: 1, a: 2 }))],
      storedEvents: [stored],
    });
    expect(canonicalJson({ z: 1, a: 2 })).toBe(canonicalJson({ a: 2, z: 1 }));
    expect(selection.alreadyRecorded).toBe(1);
    expect(selection.candidates).toEqual([]);
  });

  it('counts an unreadable payload and keeps going', () => {
    const selection = selectReplayCandidates({
      familyId: FAMILY,
      audits: [{ occurredAt: DROPPED_AT }],
      jobs: [
        job('bad', DROPPED_AT, { family_id: FAMILY }),
        job('good', DROPPED_AT, payload(secret)),
      ],
      storedEvents: [],
    });
    expect(selection.unreadable).toBe(1);
    expect(selection.candidates.map((candidate) => candidate.id)).toEqual(['good']);
  });

  it('keeps one copy when job and archive both return the same id', () => {
    const row = job('same', DROPPED_AT, payload(secret));
    const selection = selectReplayCandidates({
      familyId: FAMILY,
      audits: [{ occurredAt: DROPPED_AT }],
      jobs: [row, { ...row }],
      storedEvents: [],
    });
    expect(selection.candidates).toHaveLength(1);
  });
});

describe('replay helper is not on a schedule', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const watched = ['apps/web/lib/cron/drain.ts', 'apps/web/app/api/cron/drain/route.ts'];

  it('is not imported by the drain cron', () => {
    for (const relative of watched) {
      const source = readFileSync(`${root}${relative}`, 'utf8');
      expect(source).not.toContain('replay-spend-ceiling');
    }
  });

  it('enqueues with the same expiry the hot queue uses', () => {
    expect(REPLAY_EXPIRE_IN_SECONDS).toBe(900);
  });
});
