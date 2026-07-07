import { describe, expect, it } from 'vitest';
import type { Database } from '@hale/db';
import { assignFoundingNumber } from './founding';

/**
 * The badge must never fail onboarding: a unique-violation (two simultaneous
 * signups computing the same next ordinal) is swallowed — badge forfeited —
 * while every other database error still propagates.
 */

function dbThatThrows(error: unknown): Database {
  return {
    execute: async () => {
      throw error;
    },
  } as unknown as Database;
}

describe('assignFoundingNumber', () => {
  it('swallows a unique violation (23505) — the race forfeits the badge, not onboarding', async () => {
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    await expect(assignFoundingNumber(dbThatThrows(err), 'fam-1')).resolves.toBeUndefined();
  });

  it('propagates any other database error', async () => {
    const err = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    await expect(assignFoundingNumber(dbThatThrows(err), 'fam-1')).rejects.toThrow(
      'connection refused',
    );
  });

  it('runs the assignment for the given family when nothing throws', async () => {
    const seen: unknown[] = [];
    const database = {
      execute: async (query: unknown) => {
        seen.push(query);
      },
    } as unknown as Database;
    await assignFoundingNumber(database, 'fam-1');
    expect(seen).toHaveLength(1);
  });
});
