/**
 * VIL-394 — who may be offered a meet or a join-group.
 *
 * Pure. The only input is households that already opted in. A booking, a
 * signup, or a child is not an argument, so it cannot become part of the
 * answer. A household that has not opted in gets `{ status: 'not_opted_in' }`
 * before any other id is read into the result.
 */

export const SAME_ACTIVITY_KINDS = ['meet', 'join_group'] as const;
export type SameActivityKind = (typeof SAME_ACTIVITY_KINDS)[number];

export interface LiveOptIn {
  familyId: string;
  activityKey: string;
  kind: SameActivityKind;
  createdAtMs: number;
}

export type MutualMatch =
  | { status: 'not_opted_in' }
  | { status: 'waiting' }
  | {
      status: 'mutual';
      kind: SameActivityKind;
      counterpartFamilyIds: readonly string[];
    };

function byTimeThenId(a: LiveOptIn, b: LiveOptIn): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  if (a.familyId < b.familyId) return -1;
  if (a.familyId > b.familyId) return 1;
  return 0;
}

/** One row per household. The earliest yes wins; a duplicate cannot double a pair. */
function dedupe(rows: readonly LiveOptIn[]): LiveOptIn[] {
  const seen = new Map<string, LiveOptIn>();
  for (const row of rows) {
    const prior = seen.get(row.familyId);
    if (!prior || row.createdAtMs < prior.createdAtMs) seen.set(row.familyId, row);
  }
  return [...seen.values()];
}

export function matchSameActivity(
  rows: readonly LiveOptIn[],
  input: { familyId: string; activityKey: string; kind: SameActivityKind },
): MutualMatch {
  const optedIn = rows.some(
    (row) =>
      row.familyId === input.familyId &&
      row.activityKey === input.activityKey &&
      row.kind === input.kind,
  );
  if (!optedIn) return { status: 'not_opted_in' };

  const cohort = dedupe(
    rows.filter((row) => row.activityKey === input.activityKey && row.kind === input.kind),
  ).sort(byTimeThenId);

  if (input.kind === 'join_group') {
    const others = cohort
      .filter((row) => row.familyId !== input.familyId)
      .map((row) => row.familyId);
    if (others.length === 0) return { status: 'waiting' };
    return { status: 'mutual', kind: 'join_group', counterpartFamilyIds: others };
  }

  const ids = cohort.map((row) => row.familyId);
  const partner = new Map<string, string>();
  for (let i = 0; i + 1 < ids.length; i += 2) {
    const left = ids[i];
    const right = ids[i + 1];
    if (!left || !right) continue;
    partner.set(left, right);
    partner.set(right, left);
  }
  const counterpart = partner.get(input.familyId);
  if (!counterpart) return { status: 'waiting' };
  return { status: 'mutual', kind: 'meet', counterpartFamilyIds: [counterpart] };
}
