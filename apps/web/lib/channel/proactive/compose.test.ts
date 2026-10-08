import { describe, expect, it } from 'vitest';
import { composeProactiveBatch, withActivityLinks } from './compose';
import type { SnapshotCandidate } from './snapshot';

const ITEM: SnapshotCandidate = {
  id: 'c1',
  what: 'Fanous lantern craft',
  why: 'saved find',
  sourceUrl: 'https://tpl.example/lantern',
  worthlessAfter: null,
  parentRequested: false,
  dedupeKey: 'lantern',
};

describe('withActivityLinks', () => {
  it('appends the page when the reply names the activity and omits the link', () => {
    const linked = withActivityLinks('Fanous lantern craft is on Saturday afternoon.', [ITEM]);
    expect(linked).toContain('https://tpl.example/lantern');
  });

  it('does not attach a link the reply never named', () => {
    expect(withActivityLinks('Soccer is on this weekend.', [ITEM])).toBe(
      'Soccer is on this weekend.',
    );
  });
});

describe('composeProactiveBatch', () => {
  it('sends nothing when there is no model', async () => {
    const message = await composeProactiveBatch({
      items: [ITEM],
      client: null,
      database: {} as never,
      familyId: 'fam',
    });
    expect(message).toBeNull();
  });
});
