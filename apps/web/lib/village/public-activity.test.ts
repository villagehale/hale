import { describe, expect, it, vi } from 'vitest';
import { loadSharedActivity } from './public-activity.js';

const TOKEN = 'tok_act_123';
const RAW_TEEN_TITLE = 'Riverdale teen LGBTQ+ peer support drop-in';
const RAW_TEEN_SUMMARY = 'Confidential weekly group for your 15-year-old.';
const TEEN_CHILD_ID = 'child-teen-uuid';

interface Row {
  childId: string | null;
  title: string;
  kind: string;
  summary: string;
  sourceUrl: string | null;
  coverageNote: string | null;
  areaCoarse: string | null;
  endorsementCount: number;
}

function familyWide(overrides: Partial<Row> = {}): Row {
  return {
    childId: null,
    title: 'Saturday family swim drop-in',
    kind: 'drop_in',
    summary: 'Parent-and-child swim at the community centre.',
    sourceUrl: 'https://example.org/swim',
    coverageNote: 'serves your area',
    areaCoarse: 'M4L',
    endorsementCount: 6,
    ...overrides,
  };
}

/** Fakes the single select chain: select().from().innerJoin().where().limit(). */
function fakeDb(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never };
}

describe('loadSharedActivity — single public card (rule #1)', () => {
  it('returns null for an unknown token', async () => {
    const { db } = fakeDb([]);
    expect(await loadSharedActivity('nope', db)).toBeNull();
  });

  it('surfaces only the safe allow-list + coarse area + aggregate count', async () => {
    const { db } = fakeDb([familyWide()]);

    const card = await loadSharedActivity(TOKEN, db);

    expect(card).not.toBeNull();
    expect(Object.keys(card ?? {}).sort()).toEqual(['activity', 'areaCoarse']);
    expect(card?.areaCoarse).toBe('M4L');
    expect(Object.keys(card?.activity ?? {}).sort()).toEqual([
      'coverageNote',
      'endorsementCount',
      'kind',
      'sourceUrl',
      'summary',
      'title',
    ]);
    expect(card?.activity.endorsementCount).toBe(6);
    expect(card?.activity.title).toBe('Saturday family swim drop-in');
  });

  it('FAILS CLOSED on a child-attributed candidate — returns null, leaks nothing', async () => {
    const { db } = fakeDb([
      familyWide({ childId: TEEN_CHILD_ID, title: RAW_TEEN_TITLE, summary: RAW_TEEN_SUMMARY }),
    ]);

    const card = await loadSharedActivity(TOKEN, db);

    expect(card).toBeNull();
  });

  it('drops an unsafe sourceUrl scheme to null', async () => {
    const { db } = fakeDb([familyWide({ sourceUrl: 'data:text/html,<script>1</script>' })]);

    const card = await loadSharedActivity(TOKEN, db);
    expect(card?.activity.sourceUrl).toBeNull();
  });
});
