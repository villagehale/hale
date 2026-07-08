import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from './mappers';

/**
 * loadResolvedActions end-to-end over a fake db. Load-bearing rule-#1 + correctness
 * assertions:
 *  - a DECLINED action (reverted / declined_by_human) reads status 'declined', never
 *    'executed'; an executed (autonomous) action reads 'executed'. The two never
 *    conflate.
 *  - a teen-content action NEVER leaks its raw payload into the response (placeholder
 *    preview + null payload).
 *  - only RESOLVED actions appear — a still-pending 'drafted_for_approval' row is
 *    excluded by the query (never in history). The fake db APPLIES the captured
 *    WHERE, so flipping the loader's `ne` → `eq` (which would return only drafts)
 *    fails this assertion instead of silently passing.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NON_TEEN_DOB = '2024-05-01';
const SECRET = 'Maya said she is anxious about the dance';

vi.mock('~/auth', () => ({ auth: vi.fn() }));
vi.mock('~/lib/family', () => ({ currentFamilyId: async () => FAMILY_ID, currentUserId: async () => null }));

interface ActionRow {
  id: string;
  actionType: string;
  payload: Record<string, unknown>;
  reviewerVerdict: string;
  reviewerVerdictAt: Date | null;
  draftedAt: Date;
  userVisibleState: string;
  executedAt: Date | null;
  revertedAt: Date | null;
  revertedReason: string | null;
  teenContent: boolean;
  childId: string | null;
  childName: string | null;
  childDob: string | null;
}

function action(over: Partial<ActionRow>): ActionRow {
  return {
    id: 'act',
    actionType: 'send_email',
    payload: { to: 'clinic@ex.test', subject: 'Confirm Tuesday 3pm' },
    reviewerVerdict: 'approved',
    reviewerVerdictAt: new Date('2026-06-19T10:00:00Z'),
    draftedAt: new Date('2026-06-19T09:00:00Z'),
    userVisibleState: 'autonomous',
    executedAt: new Date('2026-06-19T11:00:00Z'),
    revertedAt: null,
    revertedReason: null,
    teenContent: false,
    childId: null,
    childName: null,
    childDob: null,
    ...over,
  };
}

// The full dataset the actions read sees — including a still-pending
// 'drafted_for_approval' row. The fake db APPLIES the captured WHERE below, so the
// query's `ne(userVisibleState, 'drafted_for_approval')` is what removes the pending
// row: a loader that flipped `ne` → `eq` would leak exactly this row.
let ALL_ROWS: ActionRow[] = [];

/**
 * Walks a Drizzle `and(eq(...), ne(...))` SQL condition and pulls out its
 * `{ column, op, value }` predicates from `queryChunks` (COL → op string → PARAM).
 * Only the operators the loader uses (`=`, `<>`) are recognized — enough to APPLY
 * the WHERE rather than ignore it.
 */
type Predicate = { column: string; op: '=' | '<>'; value: unknown };

function extractPredicates(condition: unknown): Predicate[] {
  const chunks = (condition as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return [];
  const preds: Predicate[] = [];
  let column: string | null = null;
  let op: Predicate['op'] | null = null;
  for (const chunk of chunks) {
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) {
      preds.push(...extractPredicates(chunk));
      continue;
    }
    const colName = (chunk as { name?: string; columnType?: string })?.columnType
      ? (chunk as { name: string }).name
      : null;
    if (colName) {
      column = colName;
      continue;
    }
    if ((chunk as { constructor?: { name?: string } })?.constructor?.name === 'Param') {
      if (column && op) preds.push({ column, op, value: (chunk as { value: unknown }).value });
      column = null;
      op = null;
      continue;
    }
    const text = (chunk as { value?: unknown })?.value;
    const str = Array.isArray(text) ? text.join('') : typeof text === 'string' ? text : '';
    if (str.includes('<>')) op = '<>';
    else if (str.includes('=')) op = '=';
  }
  return preds;
}

// SQL column name → the ActionRow field it maps to, for the predicates the dataset
// can evaluate (rows are already family-scoped, so family_id has no row field and is
// skipped — only user_visible_state is applied, the predicate under test).
const COLUMN_TO_FIELD: Record<string, keyof ActionRow> = {
  user_visible_state: 'userVisibleState',
};

function applyWhere(rows: ActionRow[], condition: unknown): ActionRow[] {
  const preds = extractPredicates(condition)
    .map((p) => ({ ...p, field: COLUMN_TO_FIELD[p.column] }))
    .filter((p): p is Predicate & { field: keyof ActionRow } => p.field !== undefined);
  return rows.filter((row) =>
    preds.every((p) => {
      const actual = row[p.field];
      return p.op === '=' ? actual === p.value : actual !== p.value;
    }),
  );
}

function fakeDb(childrenDob: Array<{ dateOfBirth: string }>) {
  const select = vi.fn().mockImplementation((proj: Record<string, unknown>) => {
    const keys = Object.keys(proj ?? {});
    if (keys.length === 1 && keys[0] === 'dateOfBirth') {
      return { from: () => ({ where: async () => childrenDob }) };
    }
    if (keys.length === 1 && keys[0] === 'timezone') {
      return {
        from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => [] }) }) }),
      };
    }
    const node = (rows: ActionRow[]) =>
      Object.assign(Promise.resolve(rows), {
        limit: () => Promise.resolve(rows),
        orderBy: () => node(rows),
      });
    return {
      from: () => ({
        innerJoin: () => ({
          leftJoin: () => ({ where: (cond: unknown) => node(applyWhere(ALL_ROWS, cond)) }),
        }),
      }),
    };
  });
  return { select } as never;
}

let currentChildrenDob: Array<{ dateOfBirth: string }> = [];
vi.mock('~/lib/db', () => ({ db: () => fakeDb(currentChildrenDob) }));

const { loadResolvedActions } = await import('./queries');

describe('loadResolvedActions — Approvals history', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = 'postgres://test';
    currentChildrenDob = [{ dateOfBirth: NON_TEEN_DOB }];
  });
  afterEach(() => {
    process.env.DATABASE_URL = undefined;
  });

  it('separates a declined action from an executed one — no cross-contamination', async () => {
    ALL_ROWS = [
      action({ id: 'executed-1', userVisibleState: 'autonomous', executedAt: new Date('2026-06-19T11:00:00Z') }),
      action({
        id: 'declined-1',
        userVisibleState: 'reverted',
        executedAt: null,
        revertedAt: new Date('2026-06-19T12:00:00Z'),
        revertedReason: 'declined_by_human',
      }),
    ];

    const views = await loadResolvedActions();

    const executed = views.find((v) => v.id === 'executed-1');
    const declined = views.find((v) => v.id === 'declined-1');
    expect(executed?.status).toBe('executed');
    expect(declined?.status).toBe('declined');
    // A declined row must never be reported as executed.
    expect(declined?.status).not.toBe('executed');
    expect(executed?.status).not.toBe('declined');
  });

  it('never leaks a teen action’s raw payload into the response', async () => {
    // A teen family + a teen-attributed action carrying secret text in its payload.
    currentChildrenDob = [{ dateOfBirth: '2011-01-01' }];
    ALL_ROWS = [
      action({
        id: 'teen-1',
        actionType: 'reply_to_email',
        teenContent: true,
        childId: 'teen-child',
        childName: 'Maya',
        childDob: '2011-01-01',
        payload: { to: SECRET, subject: SECRET, body: SECRET },
      }),
    ];

    const views = await loadResolvedActions();

    const row = views.find((v) => v.id === 'teen-1');
    expect(row?.preview).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(row?.payload).toBeNull();
    // Hard guarantee across the whole serialized response.
    expect(JSON.stringify(views)).not.toContain(SECRET);
  });

  it('orders newest-resolved first (by the resolved instant, not draft time)', async () => {
    ALL_ROWS = [
      action({ id: 'older', executedAt: new Date('2026-06-10T00:00:00Z') }),
      action({ id: 'newer', executedAt: new Date('2026-06-18T00:00:00Z') }),
    ];
    const views = await loadResolvedActions();
    expect(views.map((v) => v.id)).toEqual(['newer', 'older']);
  });

  it('excludes a still-pending drafted_for_approval row — history is resolved-only', async () => {
    ALL_ROWS = [
      action({ id: 'resolved-1', userVisibleState: 'autonomous' }),
      action({
        id: 'pending-1',
        userVisibleState: 'drafted_for_approval',
        executedAt: null,
        reviewerVerdictAt: null,
      }),
    ];

    const views = await loadResolvedActions();

    // The captured WHERE (ne user_visible_state 'drafted_for_approval') removes the
    // pending row; the resolved one remains. A loader that returned drafts instead
    // (ne → eq) would flip both assertions.
    expect(views.map((v) => v.id)).toEqual(['resolved-1']);
    expect(views.some((v) => v.id === 'pending-1')).toBe(false);
  });

  it('redacts an unattributed, unflagged resolved action in a teen family (rule #1 double-miss)', async () => {
    // Classifier missed (teenContent false) AND the row is unattributed (no child,
    // no DOB to derive from) — only the family-has-teen fallback stands between the
    // raw payload and the response. Mirrors approvals-double-miss.test.ts for the
    // HISTORY loader, whose age backstop was otherwise unguarded (a mutation to raw
    // row.teenContent passed every other test here).
    currentChildrenDob = [{ dateOfBirth: '2011-01-01' }, { dateOfBirth: NON_TEEN_DOB }];
    ALL_ROWS = [
      action({
        id: 'double-miss-1',
        actionType: 'reply_to_email',
        teenContent: false,
        childId: null,
        childName: null,
        childDob: null,
        payload: { to: SECRET, subject: SECRET, body: SECRET },
      }),
    ];

    const views = await loadResolvedActions();

    const row = views.find((v) => v.id === 'double-miss-1');
    expect(row?.preview).toBe(TEEN_REDACTED_PLACEHOLDER);
    expect(row?.payload).toBeNull();
    expect(JSON.stringify(views)).not.toContain(SECRET);
  });

  it('surfaces the same unattributed action unredacted in a teen-less family (no over-redaction)', async () => {
    currentChildrenDob = [{ dateOfBirth: NON_TEEN_DOB }];
    ALL_ROWS = [
      action({
        id: 'no-teen-1',
        teenContent: false,
        childId: null,
        childDob: null,
        payload: { to: 'clinic@ex.test', subject: 'Confirm Tuesday 3pm' },
      }),
    ];

    const views = await loadResolvedActions();

    expect(views[0]?.payload).not.toBeNull();
    expect(views[0]?.preview).toContain('clinic@ex.test');
  });
});
