import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateCommitmentDebt,
  cancelCommitment,
  fulfillCommitment,
  loadDueCommitments,
  loadOpenCommitment,
  loadOpenCommitments,
  recordCommitment,
} from './ledger';

/**
 * The ledger's own contract. What is pinned here is the part rule #11 cares about — a
 * promise that could not be written, and a promise that could not be closed, are NAMED
 * outcomes rather than quiet ones, because each costs something specific: an unwritten
 * promise is a debt nobody can see, and an unclosed one is a debt Hale is reported as
 * owing after it has already been paid.
 *
 * The cross-surface behaviour (intake promises → the 48h nudge pays) is proved end to
 * end in lib/__journey__/open-loop-kept.test.ts.
 */

const FAMILY = 'fam-1';
const NOW = new Date('2026-08-11T14:00:00.000Z');
const DUE = new Date('2026-08-14T14:00:00.000Z');

/** A handle whose insert leg is scripted: it records the values, and returns either the
 * minted row or — the ON CONFLICT DO NOTHING shape — no row at all. */
function insertingDb(behaviour: { conflicts?: boolean; rejects?: boolean } = {}) {
  const values: Record<string, unknown>[] = [];
  const database = {
    insert: () => ({
      values: (payload: Record<string, unknown>) => {
        values.push(payload);
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (behaviour.rejects) throw new Error('violates check constraint');
              return behaviour.conflicts ? [] : [{ id: 'commitment-1' }];
            },
          }),
        };
      },
    }),
  } as unknown as Database;
  return { database, values };
}

/** A handle whose update leg is scripted, returning the rows the WHERE matched. */
function updatingDb(behaviour: { matched?: string[]; rejects?: boolean } = {}) {
  const sets: Record<string, unknown>[] = [];
  const database = {
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        sets.push(payload);
        return {
          where: () => ({
            returning: async () => {
              if (behaviour.rejects) throw new Error('connection terminated');
              return (behaviour.matched ?? ['commitment-1']).map((id) => ({ id }));
            },
          }),
        };
      },
    }),
  } as unknown as Database;
  return { database, sets };
}

/** A handle whose one select returns exactly these rows, awaited with or without an
 * `orderBy` and a `limit` — the real query builder is thenable at all three points. */
function readingDb(rows: unknown[]) {
  const result = {
    orderBy: () => result,
    limit: () => result,
    // biome-ignore lint/suspicious/noThenProperty: test double of a thenable query builder
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej),
  };
  return {
    select: () => ({ from: () => ({ where: () => result }) }),
  } as unknown as Database;
}

describe('recordCommitment', () => {
  it('writes the promise against the ledger row that carried it', async () => {
    const { database, values } = insertingDb();

    const outcome = await recordCommitment(database, {
      familyId: FAMILY,
      kind: 'first_find',
      summary: 'Your first weekend find lands in a day or two.',
      dueAt: DUE,
      channelMessageId: 'msg-1',
    });

    expect(outcome).toEqual({ status: 'recorded', commitmentId: 'commitment-1' });
    expect(values).toEqual([
      {
        familyId: FAMILY,
        commitmentKind: 'first_find',
        summary: 'Your first weekend find lands in a day or two.',
        topic: null,
        subjectChildId: null,
        dueAt: DUE,
        createdFrom: 'msg-1',
      },
    ]);
  });

  it('carries the topic for the kinds whose fulfilment needs one', async () => {
    const { database, values } = insertingDb();

    // A bare YES two days later has to resolve to the plan Hale actually offered, and
    // the check-in after that has to say which plan it is asking about. The subject is
    // a closed-vocabulary category, so it is safe to persist beside a family id.
    await recordCommitment(database, {
      familyId: FAMILY,
      kind: 'plan_offer',
      summary: 'Offered the full sleep plan - waiting on a yes.',
      topic: 'sleep',
      dueAt: DUE,
      channelMessageId: 'msg-1',
    });

    expect(values[0]).toMatchObject({ commitmentKind: 'plan_offer', topic: 'sleep' });
  });

  it('refuses to mint a debt for a message that never left the building', async () => {
    const { database, values } = insertingDb();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Composing is not promising. A message with no ledger row behind it never reached a
    // transport, so no parent is waiting on anything.
    const outcome = await recordCommitment(database, {
      familyId: FAMILY,
      kind: 'first_find',
      summary: 'Your first weekend find lands in a day or two.',
      dueAt: DUE,
      channelMessageId: null,
    });

    expect(outcome).toEqual({ status: 'not_recorded', reason: 'no_ledger_row' });
    expect(values).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('names a re-fired promise as already open rather than as a write', async () => {
    const { database } = insertingDb({ conflicts: true });

    // The partial unique index refused it: this family already owes this kind. Not a
    // failure and not a fresh debt — a third thing, and the caller can tell.
    const outcome = await recordCommitment(database, {
      familyId: FAMILY,
      kind: 'first_find',
      summary: 'Your first weekend find lands in a day or two.',
      dueAt: DUE,
      channelMessageId: 'msg-2',
    });

    expect(outcome).toEqual({ status: 'already_open' });
  });

  it('names a failed write rather than throwing it into a send path', async () => {
    const { database } = insertingDb({ rejects: true });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The SMS is already with the parent. Throwing here would have the carrier retry the
    // webhook and provision the household a second time.
    const outcome = await recordCommitment(database, {
      familyId: FAMILY,
      kind: 'first_find',
      summary: 'Your first weekend find lands in a day or two.',
      dueAt: DUE,
      channelMessageId: 'msg-1',
    });

    expect(outcome).toEqual({ status: 'not_recorded', reason: 'write_failed' });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe('fulfillCommitment', () => {
  it('closes the open promise against the message that made good on it', async () => {
    const { database, sets } = updatingDb();

    const outcome = await fulfillCommitment(database, {
      familyId: FAMILY,
      kind: 'first_find',
      channelMessageId: 'msg-9',
      now: NOW,
    });

    expect(outcome).toEqual({ status: 'closed', commitmentIds: ['commitment-1'] });
    expect(sets).toEqual([{ fulfilledAt: NOW, fulfilledBy: 'msg-9' }]);
  });

  it('reports nothing to close as its own outcome', async () => {
    const { database } = updatingDb({ matched: [] });

    // The common case: most nudges answer no promise at all. It must not read as a
    // failure, or the sweep's logs would be nothing but noise.
    const outcome = await fulfillCommitment(database, {
      familyId: FAMILY,
      kind: 'first_find',
      channelMessageId: 'msg-9',
      now: NOW,
    });

    expect(outcome).toEqual({ status: 'none_open' });
  });

  it('will not close a promise against a message that left no ledger row', async () => {
    const { database, sets } = updatingDb();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await fulfillCommitment(database, {
      familyId: FAMILY,
      kind: 'first_find',
      channelMessageId: null,
      now: NOW,
    });

    // A kept promise has to say WHAT kept it — the schema's closure check forbids the
    // half-row, and so does the writer, with a reason.
    expect(outcome).toEqual({ status: 'not_closed', reason: 'no_ledger_row' });
    expect(sets).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('names a failed close rather than throwing it into a send path', async () => {
    const { database } = updatingDb({ rejects: true });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await fulfillCommitment(database, {
      familyId: FAMILY,
      kind: 'first_find',
      channelMessageId: 'msg-9',
      now: NOW,
    });

    // The cost is specific and it is in the log: Hale will be reported as owing this
    // family something it has already delivered.
    expect(outcome).toEqual({ status: 'not_closed', reason: 'write_failed' });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe('cancelCommitment', () => {
  it('voids the promise with the reason it was voided for', async () => {
    const { database, sets } = updatingDb();

    const outcome = await cancelCommitment(database, {
      familyId: FAMILY,
      kind: 'registration_plan',
      reason: 'shortlist_declined',
      now: NOW,
    });

    expect(outcome).toEqual({ status: 'closed', commitmentIds: ['commitment-1'] });
    expect(sets).toEqual([{ cancelledAt: NOW, cancelledReason: 'shortlist_declined' }]);
  });
});

describe('loadOpenCommitments', () => {
  it('says which of the open promises are already late', async () => {
    const database = readingDb([
      {
        id: 'c-1',
        commitmentKind: 'first_find',
        summary: 'Your first weekend find lands in a day or two.',
        dueAt: new Date('2026-08-10T14:00:00.000Z'),
      },
      {
        id: 'c-2',
        commitmentKind: 'registration_plan',
        summary: 'Richmond Hill Fall 2026: your plan, the evening before.',
        dueAt: new Date('2026-08-20T14:00:00.000Z'),
      },
    ]);

    const open = await loadOpenCommitments(database, FAMILY, NOW);

    expect(open).toEqual([
      {
        id: 'c-1',
        kind: 'first_find',
        summary: 'Your first weekend find lands in a day or two.',
        dueAt: new Date('2026-08-10T14:00:00.000Z'),
        overdue: true,
      },
      {
        id: 'c-2',
        kind: 'registration_plan',
        summary: 'Richmond Hill Fall 2026: your plan, the evening before.',
        dueAt: new Date('2026-08-20T14:00:00.000Z'),
        overdue: false,
      },
    ]);
  });
});

describe('loadOpenCommitment', () => {
  it('returns the one open promise of a kind, with the subject its fulfilment needs', async () => {
    const database = readingDb([
      {
        id: 'c-1',
        summary: 'Offered the full sleep plan - waiting on a yes.',
        topic: 'sleep',
        subjectChildId: 'child-1',
        dueAt: DUE,
      },
    ]);

    expect(await loadOpenCommitment(database, FAMILY, 'plan_offer')).toEqual({
      id: 'c-1',
      summary: 'Offered the full sleep plan - waiting on a yes.',
      topic: 'sleep',
      subjectChildId: 'child-1',
      dueAt: DUE,
    });
  });

  it('reads no open promise as null rather than as a default one', async () => {
    // The overwhelmingly common case on every inbound text, and the reason the YES
    // handler can decline in one query: nothing is open, so nothing is claimed.
    expect(await loadOpenCommitment(readingDb([]), FAMILY, 'plan_offer')).toBeNull();
  });
});

describe('loadDueCommitments', () => {
  it('hands the sweep the families whose promise has come due', async () => {
    const database = readingDb([
      { id: 'c-1', familyId: 'fam-1', topic: 'sleep', dueAt: NOW },
      { id: 'c-2', familyId: 'fam-2', topic: 'solids', dueAt: NOW },
    ]);

    expect(await loadDueCommitments(database, 'plan_check_in', NOW, 50)).toEqual([
      { id: 'c-1', familyId: 'fam-1', topic: 'sleep', dueAt: NOW },
      { id: 'c-2', familyId: 'fam-2', topic: 'solids', dueAt: NOW },
    ]);
  });
});

describe('aggregateCommitmentDebt', () => {
  it('counts families owed, not promises owed', async () => {
    const database = readingDb([
      // One family, two late promises — one family is what a founder acts on.
      { familyId: 'fam-1', dueAt: new Date('2026-08-09T14:00:00.000Z') },
      { familyId: 'fam-1', dueAt: new Date('2026-08-10T14:00:00.000Z') },
      { familyId: 'fam-2', dueAt: new Date('2026-08-10T14:00:00.000Z') },
      // Still in time: open, and not a debt anyone has been let down by.
      { familyId: 'fam-3', dueAt: new Date('2026-08-30T14:00:00.000Z') },
    ]);

    const debt = await aggregateCommitmentDebt(database, NOW);

    expect(debt).toEqual({ overdueFamilies: 2, overdueCommitments: 3, openCommitments: 4 });
  });

  it('distinguishes an empty ledger from a ledger with nothing late', async () => {
    const debt = await aggregateCommitmentDebt(readingDb([]), NOW);

    expect(debt).toEqual({ overdueFamilies: 0, overdueCommitments: 0, openCommitments: 0 });
  });
});
