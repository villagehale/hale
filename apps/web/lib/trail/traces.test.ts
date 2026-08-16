import { describe, expect, it } from 'vitest';
import type { TrailView } from '~/lib/dashboard/mappers';
import { groupIntoTraces, trailItemKey } from './traces';

function row(id: string, actionId: string | null, summary = 'recorded an update'): TrailView {
  return {
    id,
    time: '14:05',
    date: 'Thursday, Jun 11',
    dayKey: '2026-06-11',
    tone: 'done',
    actor: 'hale',
    summary,
    noun: 'draft',
    link: '/approvals',
    childLabel: null,
    teenRedacted: false,
    actionId,
    reversalKept: false,
  };
}

describe('groupIntoTraces — several rows about one action are one thing that happened', () => {
  it('folds an action’s rows into a single trace, in the order they arrived', () => {
    const items = groupIntoTraces([
      row('e3', 'act-1', 'carried out the action'),
      row('e2', 'act-1', 'you approved the action'),
      row('e1', 'act-1', 'drafted an action for you'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'trace', actionId: 'act-1' });
    expect(items[0]?.kind === 'trace' && items[0].rows.map((r) => r.id)).toEqual([
      'e3',
      'e2',
      'e1',
    ]);
  });

  it('leaves a lone row alone — a one-step trace has nothing to disclose', () => {
    const items = groupIntoTraces([row('e1', 'act-1')]);
    expect(items).toEqual([{ kind: 'single', row: row('e1', 'act-1') }]);
  });

  it('leaves rows that resolve to no action alone, however many there are', () => {
    const items = groupIntoTraces([row('e1', null), row('e2', null), row('e3', null)]);
    expect(items.map((i) => i.kind)).toEqual(['single', 'single', 'single']);
  });

  it('keeps different actions apart, and never drops a row', () => {
    const input = [
      row('e5', 'act-2'),
      row('e4', 'act-1'),
      row('e3', null),
      row('e2', 'act-2'),
      row('e1', 'act-1'),
    ];
    const items = groupIntoTraces(input);
    // act-2 folds first (its newest row came first), then act-1, then the loose row
    // stays where it was — the day still reads newest-first by what last happened.
    expect(items.map((i) => (i.kind === 'trace' ? i.actionId : i.row.id))).toEqual([
      'act-2',
      'act-1',
      'e3',
    ]);
    const seen = items.flatMap((i) => (i.kind === 'trace' ? i.rows : [i.row])).map((r) => r.id);
    expect(seen.sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });

  it('emits each action exactly once, however many rows it has', () => {
    const items = groupIntoTraces([
      row('e1', 'act-1'),
      row('e2', 'act-1'),
      row('e3', 'act-1'),
      row('e4', 'act-1'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind === 'trace' && items[0].rows).toHaveLength(4);
  });

  it('keys a trace and a row apart, so a uuid shared across tables cannot collide', () => {
    const shared = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    expect(trailItemKey({ kind: 'trace', actionId: shared, rows: [] })).not.toBe(
      trailItemKey({ kind: 'single', row: row(shared, null) }),
    );
  });
});
