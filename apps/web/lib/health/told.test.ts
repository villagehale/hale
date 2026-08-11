import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import {
  checkpointToldKey,
  loadToldCheckpointRefs,
  recordCheckpointTold,
} from './told';

/**
 * The told-marker's own contract. The cross-surface behaviour it buys is proved in
 * lib/__journey__/checkpoint-told-once.test.ts; what is pinned here is the part rule #11
 * cares about — a marker that does not land is a NAMED outcome, never a quiet one,
 * because the family can be told the same thing twice on the strength of it.
 */

const FAMILY = 'fam-1';
const REF = 'immunization_6_months:kid-1:0';

/**
 * A handle whose update leg is scripted: it records the write, or rejects it the way
 * the real driver does — on the await, not on the builder call.
 */
function updatingDb(behaviour: { rejects?: boolean } = {}) {
  const sets: Record<string, unknown>[] = [];
  const database = {
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        sets.push(payload);
        return {
          where: async () => {
            if (behaviour.rejects) {
              throw new Error('duplicate key value violates unique constraint');
            }
          },
        };
      },
    }),
  } as unknown as Database;
  return { database, sets };
}

/** A handle whose one select returns exactly these ledger rows. */
function readingDb(rows: Array<{ dedupeKey: string | null }>) {
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
  } as unknown as Database;
}

describe('recordCheckpointTold', () => {
  it('stamps the checkpoint identity on the row that carried the message', async () => {
    const { database, sets } = updatingDb();

    const outcome = await recordCheckpointTold(database, {
      familyId: FAMILY,
      ref: REF,
      channelMessageId: 'msg-1',
    });

    expect(outcome).toEqual({ status: 'recorded' });
    expect(sets).toEqual([{ dedupeKey: checkpointToldKey(FAMILY, REF) }]);
  });

  it('names the absence when the message left no ledger row behind', async () => {
    const { database, sets } = updatingDb();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = await recordCheckpointTold(database, {
      familyId: FAMILY,
      ref: REF,
      channelMessageId: null,
    });

    // Not a no-op with a cheerful return: the caller is told the marker is gone, and the
    // log says what that costs — this checkpoint can be raised again.
    expect(outcome).toEqual({ status: 'not_recorded', reason: 'no_ledger_row' });
    expect(sets).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[1])).toContain('may be raised again');
    logged.mockRestore();
  });

  it('names a failed write rather than throwing it into a conversation', async () => {
    const { database } = updatingDb({ rejects: true });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The SMS is already with the parent by the time this runs. Throwing would have the
    // carrier retry the webhook and provision the family a second time.
    const outcome = await recordCheckpointTold(database, {
      familyId: FAMILY,
      ref: REF,
      channelMessageId: 'msg-1',
    });

    expect(outcome).toEqual({ status: 'not_recorded', reason: 'write_failed' });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe('loadToldCheckpointRefs', () => {
  it('reads a marker back whatever surface wrote it, and ignores what is not one', async () => {
    const database = readingDb([
      { dedupeKey: checkpointToldKey(FAMILY, REF) },
      { dedupeKey: checkpointToldKey(FAMILY, 'school_records_ispa:*:2026') },
      // Survives the prefix but is not a checkpoint this build ships — a stale ref must
      // not silence a live row it happens to sort near.
      { dedupeKey: checkpointToldKey(FAMILY, 'immunization_retired:kid-1:0') },
      { dedupeKey: null },
    ]);

    const refs = await loadToldCheckpointRefs(database, FAMILY);

    expect([...refs].sort()).toEqual([REF, 'school_records_ispa:*:2026']);
  });
});
