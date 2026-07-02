import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@hale/db';
import { getMemorySlice } from './memory-writer.js';

const familyId = '11111111-1111-4111-8111-111111111111';
const existingFactId = '55555555-5555-4555-8555-555555555555';
const episodeId = '66666666-6666-4666-8666-666666666666';

/**
 * A chainable query-builder stub. Every terminal builder method resolves to the
 * rows configured for the call. A per-call queue lets the two selects
 * getMemorySlice runs (currently-valid facts, then recent episodes) each return
 * their own rows.
 */
function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of ['where', 'from', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are deliberately thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

/** A fake Database whose selects drain a per-call queue of row sets. */
function stubDb(selectQueue: unknown[][]) {
  const queue = [...selectQueue];
  return {
    select: vi.fn(() => builder(queue.shift() ?? [])),
  } as unknown as Database;
}

describe('getMemorySlice', () => {
  it('returns currently-valid facts and recent episodes', async () => {
    const facts = [{ id: existingFactId, factType: 'routine', factKey: 'bedtime' }];
    const episodes = [{ id: episodeId, episodeType: 'appointment_confirmed' }];
    const database = stubDb([facts, episodes]);

    const slice = await getMemorySlice(familyId, database);

    expect(slice.facts).toEqual(facts);
    expect(slice.episodes).toEqual(episodes);
  });
});
