import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type LiveOptIn,
  SAME_ACTIVITY_KINDS,
  type SameActivityKind,
  matchSameActivity,
} from './match';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const KEY = 'pool.example|saturday-swim|2026-10-01T15:00:00.000Z';
const OTHER = 'library.example|storytime|2026-10-02T15:00:00.000Z';

function row(
  familyId: string,
  overrides: { activityKey?: string; kind?: SameActivityKind; createdAtMs?: number } = {},
): LiveOptIn {
  return {
    familyId,
    activityKey: overrides.activityKey ?? KEY,
    kind: overrides.kind ?? 'meet',
    createdAtMs: overrides.createdAtMs ?? 1,
  };
}

describe('matchSameActivity', () => {
  it('returns not_opted_in before any other household can appear', () => {
    const result = matchSameActivity([row(B)], { familyId: A, activityKey: KEY, kind: 'meet' });
    expect(result).toEqual({ status: 'not_opted_in' });
    expect(JSON.stringify(result)).not.toContain(B);
    expect(Object.keys(result)).toEqual(['status']);
  });

  it('waits, and names nobody, when only this household has opted in', () => {
    const result = matchSameActivity([row(A), row(C, { activityKey: OTHER })], {
      familyId: A,
      activityKey: KEY,
      kind: 'meet',
    });
    expect(result).toEqual({ status: 'waiting' });
    expect(JSON.stringify(result)).not.toContain(C);
    expect(JSON.stringify(result)).not.toContain(OTHER);
  });

  it('pairs a meet only when both households opted into the same activity', () => {
    const result = matchSameActivity([row(A, { createdAtMs: 2 }), row(B, { createdAtMs: 1 })], {
      familyId: A,
      activityKey: KEY,
      kind: 'meet',
    });
    expect(result).toEqual({
      status: 'mutual',
      kind: 'meet',
      counterpartFamilyIds: [B],
    });
    const back = matchSameActivity([row(A, { createdAtMs: 2 }), row(B, { createdAtMs: 1 })], {
      familyId: B,
      activityKey: KEY,
      kind: 'meet',
    });
    expect(back).toEqual({
      status: 'mutual',
      kind: 'meet',
      counterpartFamilyIds: [A],
    });
  });

  it('does not match a meet yes to a join-group yes', () => {
    const result = matchSameActivity([row(A), row(B, { kind: 'join_group' })], {
      familyId: A,
      activityKey: KEY,
      kind: 'meet',
    });
    expect(result).toEqual({ status: 'waiting' });
    expect(JSON.stringify(result)).not.toContain(B);
  });

  it('leaves the unpaired household unnamed when three households opt into a meet', () => {
    const rows = [
      row(A, { createdAtMs: 1 }),
      row(B, { createdAtMs: 2 }),
      row(C, { createdAtMs: 3 }),
    ];
    expect(matchSameActivity(rows, { familyId: A, activityKey: KEY, kind: 'meet' })).toEqual({
      status: 'mutual',
      kind: 'meet',
      counterpartFamilyIds: [B],
    });
    const waiting = matchSameActivity(rows, { familyId: C, activityKey: KEY, kind: 'meet' });
    expect(waiting).toEqual({ status: 'waiting' });
    expect(JSON.stringify(waiting)).not.toContain(A);
    expect(JSON.stringify(waiting)).not.toContain(B);
  });

  it('includes every other household that opted into the same join-group', () => {
    const rows = [
      row(B, { kind: 'join_group', createdAtMs: 2 }),
      row(A, { kind: 'join_group', createdAtMs: 1 }),
      row(C, { kind: 'join_group', createdAtMs: 3 }),
    ];
    expect(matchSameActivity(rows, { familyId: A, activityKey: KEY, kind: 'join_group' })).toEqual({
      status: 'mutual',
      kind: 'join_group',
      counterpartFamilyIds: [B, C],
    });
    const stranger = matchSameActivity(rows, {
      familyId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      activityKey: KEY,
      kind: 'join_group',
    });
    expect(stranger).toEqual({ status: 'not_opted_in' });
    expect(JSON.stringify(stranger)).not.toContain(A);
  });

  it('keeps the kind list in step with migration 0145', () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../../packages/db/drizzle/0145_same_activity_opt_ins.sql',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    for (const kind of SAME_ACTIVITY_KINDS) expect(sql).toContain(`'${kind}'`);
  });
});
