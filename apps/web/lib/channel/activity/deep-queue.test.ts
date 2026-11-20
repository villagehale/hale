import type { schema } from '@hale/db';
import type { DeepResearchPayload } from '@hale/tools-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEEP_RESEARCH_QUEUE,
  type DeepResearchQueue,
  dispatchDeepResearch,
  dispatchDepthForPromise,
} from './deep-queue';

/**
 * THE DISPATCH, ON THE RECORD. Whether a promise is researched in minutes or kept for the
 * hourly sweep used to live only in a log line nobody keeps. Each dispatch now leaves one
 * audit row on the commitment it is about, carrying the outcome and never the subject.
 */

const PAYLOAD: DeepResearchPayload = { commitment_id: 'commit-7', family_id: 'fam-7' };
/** The adult whose 1:1 ask made the promise. */
const ASKED_BY = 'parent-7';

type AuditRow = typeof schema.auditLog.$inferInsert;

function queue(sent: string | null): DeepResearchQueue & { sends: unknown[] } {
  const q = {
    sends: [] as unknown[],
    async createQueue() {},
    async updateQueue() {},
    async send(name: string, data: DeepResearchPayload, options?: unknown) {
      q.sends.push({ name, data, options });
      return sent;
    },
  };
  return q;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dispatchDeepResearch', () => {
  it('enqueues the job keyed to the commitment and writes ONE audit row on that commitment', async () => {
    const q = queue('job-1');
    const audited: AuditRow[] = [];

    const outcome = await dispatchDeepResearch(
      { resolve: async () => q, audit: async (row) => void audited.push(row) },
      PAYLOAD,
      ASKED_BY,
    );

    expect(outcome).toEqual({ status: 'enqueued' });
    expect(q.sends).toEqual([
      {
        name: DEEP_RESEARCH_QUEUE,
        data: PAYLOAD,
        options: expect.objectContaining({ id: 'commit-7', singletonKey: 'commit-7' }),
      },
    ]);
    expect(audited).toEqual([
      {
        familyId: 'fam-7',
        actor: 'system',
        actionTaken: 'activity_deep_dispatched',
        targetTable: 'agent_commitments',
        targetId: 'commit-7',
        after: { status: 'enqueued' },
        // VIL-635: one adult's ask, so the row is that adult's, not every parent seat's.
        audience: ASKED_BY,
      },
    ]);
  });

  it('a send that created nothing is already_queued, and says so on the row', async () => {
    const audited: AuditRow[] = [];
    const outcome = await dispatchDeepResearch(
      { resolve: async () => queue(null), audit: async (row) => void audited.push(row) },
      PAYLOAD,
      ASKED_BY,
    );
    expect(outcome).toEqual({ status: 'already_queued' });
    expect(audited.map((row) => row.after)).toEqual([{ status: 'already_queued' }]);
  });

  it('a queue that cannot be opened is queue_unavailable, on the row as well as the outcome', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const audited: AuditRow[] = [];
    const outcome = await dispatchDeepResearch(
      {
        resolve: async () => {
          throw new Error('connect ECONNREFUSED');
        },
        audit: async (row) => void audited.push(row),
      },
      PAYLOAD,
      ASKED_BY,
    );
    expect(outcome).toEqual({ status: 'not_enqueued', reason: 'queue_unavailable' });
    expect(audited.map((row) => row.after)).toEqual([
      { status: 'not_enqueued', reason: 'queue_unavailable' },
    ]);
  });

  it('an audit write that fails still returns the true outcome and never throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await dispatchDeepResearch(
      {
        resolve: async () => queue('job-1'),
        audit: async () => {
          throw new TypeError('audit insert refused');
        },
      },
      PAYLOAD,
      ASKED_BY,
    );
    expect(outcome).toEqual({ status: 'enqueued' });
    expect(error).toHaveBeenCalledWith(
      { commitmentId: 'commit-7', err: 'TypeError' },
      expect.any(String),
    );
  });

  it('the row carries the outcome only: no subject, no topic, no words', async () => {
    const audited: AuditRow[] = [];
    await dispatchDeepResearch(
      { resolve: async () => queue('job-1'), audit: async (row) => void audited.push(row) },
      PAYLOAD,
      ASKED_BY,
    );
    // Positive control first: there IS a row, with an `after`, to look inside.
    expect(audited).toHaveLength(1);
    expect(Object.keys(audited[0]?.after as object)).toEqual(['status']);
  });
});

describe('dispatchDepthForPromise', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lit: dispatches every recorded promise, whatever it is about, for the adult who asked', async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'true');
    const dispatched: Array<{ payload: DeepResearchPayload; askedBy: string }> = [];
    const outcome = await dispatchDepthForPromise(
      async (payload, askedBy) => {
        dispatched.push({ payload, askedBy });
        return { status: 'enqueued' };
      },
      {
        familyId: 'fam-7',
        parentUserId: ASKED_BY,
        recorded: { status: 'recorded', commitmentId: 'commit-7' },
      },
    );
    expect(outcome).toEqual({ status: 'enqueued' });
    // The adult rides beside the job, never inside it: the payload stays ids of the promise.
    expect(dispatched).toEqual([{ payload: PAYLOAD, askedBy: ASKED_BY }]);
  });

  // Dark, the question-time pass is not queued at all: the promise row is left exactly as
  // the router wrote it, due in a day, for the hourly sweep — the path before #1251.
  it.each([
    ['false', { DEEP_FOLLOWUP_NOW_ENABLED: 'false' }],
    [
      'false, with the family on the retired allowlist',
      { DEEP_FOLLOWUP_NOW_ENABLED: 'false', DEEP_FOLLOWUP_NOW_FAMILY_ALLOWLIST: 'fam-7' },
    ],
  ])('dark (%s): a recorded promise is not dispatched, and says why', async (_label, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const dispatch = vi.fn();
    const outcome = await dispatchDepthForPromise(dispatch, {
      familyId: 'fam-7',
      parentUserId: ASKED_BY,
      recorded: { status: 'recorded', commitmentId: 'commit-7' },
    });
    expect(outcome).toEqual({ status: 'not_enqueued', reason: 'followup_now_dark' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('unset is lit: a recorded promise is dispatched', async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', undefined);
    const dispatch = vi.fn(async () => ({ status: 'enqueued' as const }));
    const outcome = await dispatchDepthForPromise(dispatch, {
      familyId: 'fam-7',
      parentUserId: ASKED_BY,
      recorded: { status: 'recorded', commitmentId: 'commit-7' },
    });
    expect(outcome).toEqual({ status: 'enqueued' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('a promise that never became a row is not dispatched', async () => {
    vi.stubEnv('DEEP_FOLLOWUP_NOW_ENABLED', 'true');
    const dispatch = vi.fn();
    const outcome = await dispatchDepthForPromise(dispatch, {
      familyId: 'fam-7',
      parentUserId: ASKED_BY,
      recorded: { status: 'not_recorded', reason: 'no_ledger_row' },
    });
    expect(outcome).toEqual({ status: 'not_enqueued', reason: 'not_recorded' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
