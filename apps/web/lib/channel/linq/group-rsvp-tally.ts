/**
 * VIL-102 — household counts for one group RSVP plan. Pure. A household is one
 * vote. Pending is seats Hale already knows who have not said yes or no.
 */

export type TallyResponse = 'yes' | 'no' | 'pending';

export interface TallyHousehold {
  householdKey: string;
  displayName: string | null;
  response: TallyResponse;
  familyId: string | null;
  calendarPermission: 'pending' | 'granted' | 'refused' | null;
  calendarEventId: string | null;
}

export interface RsvpTally {
  yes: number;
  no: number;
  pending: number;
  yesNames: string[];
  noNames: string[];
  pendingNames: string[];
  households: TallyHousehold[];
}

export function householdKeyFor(input: {
  familyId: string | null;
  phoneHash: string | null;
}): string | null {
  if (input.familyId) return `family:${input.familyId}`;
  if (input.phoneHash) return `phone:${input.phoneHash}`;
  return null;
}

export function tallyHouseholds(
  replies: readonly TallyHousehold[],
  expectedKeys: readonly string[],
): RsvpTally {
  const byKey = new Map(replies.map((row) => [row.householdKey, row]));
  for (const key of expectedKeys) {
    if (!byKey.has(key)) {
      byKey.set(key, {
        householdKey: key,
        displayName: null,
        response: 'pending',
        familyId: key.startsWith('family:') ? key.slice('family:'.length) : null,
        calendarPermission: null,
        calendarEventId: null,
      });
    }
  }
  const households = [...byKey.values()];
  const named = (response: TallyResponse) =>
    households
      .filter((row) => row.response === response && row.displayName)
      .map((row) => row.displayName as string);
  return {
    yes: households.filter((row) => row.response === 'yes').length,
    no: households.filter((row) => row.response === 'no').length,
    pending: households.filter((row) => row.response === 'pending').length,
    yesNames: named('yes'),
    noNames: named('no'),
    pendingNames: named('pending'),
    households,
  };
}

/** A restated yes or no is not a reason to speak. A first answer, a flip, or a new plan is. */
export function tallyChangedMeaningfully(
  before: Pick<RsvpTally, 'yes' | 'no' | 'pending'> | null,
  after: Pick<RsvpTally, 'yes' | 'no' | 'pending'>,
): boolean {
  if (!before) return true;
  return before.yes !== after.yes || before.no !== after.no || before.pending !== after.pending;
}

export function tapbackVote(
  reactionType: string | null,
): Extract<TallyResponse, 'yes' | 'no' | 'pending'> | null {
  if (!reactionType) return null;
  const type = reactionType.trim().toLowerCase();
  if (type === 'like' || type === 'love' || type === 'emphasize' || type === 'heart') return 'yes';
  if (type === 'dislike' || type === 'thumbsdown') return 'no';
  if (type === 'question') return 'pending';
  return null;
}
