import type { Database } from '@hale/db';
import { readSameActivityChoice } from './choice';
import { type SameActivityReply, deliverSameActivityReply, renderSameActivityReply } from './copy';
import { sameActivityMeetEnabled } from './flag';
import { type SameActivityKind, matchSameActivity } from './match';
import {
  loadActivityCohort,
  loadCallerOptIn,
  parseActivityKey,
  recordHouseholdOptIn,
  revokeHouseholdOptIn,
} from './store';

export interface SameActivityDisclosure {
  status: 'not_opted_in' | 'waiting' | 'mutual';
  reply: SameActivityReply;
  kind?: SameActivityKind;
  counterpartFamilyIds?: readonly string[];
}

/**
 * What this household may be told. Flag off does not read the table.
 * A household with no yes does not read anyone else's yes. Counterpart ids
 * are attached only when both sides have a live opt-in, and the reply text
 * is chosen without them.
 */
export async function prepareSameActivityOffer(
  database: Database,
  input: { familyId: string; activityKey: string; kind: SameActivityKind },
): Promise<
  | { status: 'skipped'; reason: 'flag_off' }
  | { status: 'refused'; reason: 'invalid_activity' }
  | SameActivityDisclosure
> {
  if (!sameActivityMeetEnabled()) return { status: 'skipped', reason: 'flag_off' };
  const activityKey = parseActivityKey(input.activityKey);
  if (!activityKey) return { status: 'refused', reason: 'invalid_activity' };

  const own = await loadCallerOptIn(database, {
    familyId: input.familyId,
    activityKey,
    kind: input.kind,
  });
  if (!own) {
    return {
      status: 'not_opted_in',
      reply: renderSameActivityReply('not_opted_in', null),
    };
  }

  const cohort = await loadActivityCohort(database, { activityKey, kind: input.kind });
  const match = matchSameActivity(cohort, {
    familyId: input.familyId,
    activityKey,
    kind: input.kind,
  });
  if (match.status === 'mutual') {
    return {
      status: 'mutual',
      kind: match.kind,
      counterpartFamilyIds: match.counterpartFamilyIds,
      reply: renderSameActivityReply('mutual', match.kind),
    };
  }
  return {
    status: 'waiting',
    reply: renderSameActivityReply('waiting', input.kind),
  };
}

export type SameActivityAnswer =
  | { status: 'skipped'; reason: 'flag_off' }
  | { status: 'refused'; reason: 'invalid_activity' | 'invalid_message' | 'invalid_kind' }
  | { status: 'unread'; reply: SameActivityReply }
  | { status: 'declined'; recorded: 'revoked' | 'already_off'; reply: SameActivityReply }
  | (SameActivityDisclosure & { recorded: 'created' | 'already' });

/**
 * Apply one explicit reply. "no" revokes even when the flag is off. A yes
 * while the flag is off records nothing and does not look for a match.
 * An unclear body is not a yes and does not read other households.
 */
export async function answerSameActivity(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    activityKey: string;
    messageId: string;
    body: string;
  },
): Promise<SameActivityAnswer> {
  const activityKey = parseActivityKey(input.activityKey);
  if (!activityKey) return { status: 'refused', reason: 'invalid_activity' };
  const choice = readSameActivityChoice(input.body);

  if (choice === 'no') {
    const revoked = await revokeHouseholdOptIn(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      activityKey,
      kind: 'meet',
    });
    const group = await revokeHouseholdOptIn(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      activityKey,
      kind: 'join_group',
    });
    const recorded =
      revoked.status === 'revoked' || group.status === 'revoked' ? 'revoked' : 'already_off';
    return {
      status: 'declined',
      recorded,
      reply: renderSameActivityReply('declined', null),
    };
  }

  if (!sameActivityMeetEnabled()) return { status: 'skipped', reason: 'flag_off' };
  if (choice === null) {
    return { status: 'unread', reply: renderSameActivityReply('unread', null) };
  }

  const recorded = await recordHouseholdOptIn(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    activityKey,
    kind: choice,
    messageId: input.messageId,
  });
  if (recorded.status === 'refused') return recorded;
  if (recorded.status === 'skipped') return recorded;

  const disclosure = await prepareSameActivityOffer(database, {
    familyId: input.familyId,
    activityKey,
    kind: choice,
  });
  if (disclosure.status === 'skipped' || disclosure.status === 'refused') return disclosure;
  return { ...disclosure, recorded: recorded.status === 'recorded' ? 'created' : 'already' };
}

export { deliverSameActivityReply };
