import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { readSameActivityChoice } from './choice';
import {
  type SameActivityReply,
  deliverSameActivityReply,
  renderSameActivityReply,
  sameActivityDeclineToOtherSide,
  sameActivityFirstName,
} from './copy';
import { sameActivityMeetEnabled } from './flag';
import { type SameActivityKind, matchSameActivity } from './match';
import {
  loadActivityCohort,
  loadCallerOptIn,
  loadCounterpartGivenName,
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

async function languageFor(
  database: Database,
  input: { language?: ReplyLanguage; parentUserId?: string },
): Promise<ReplyLanguage> {
  if (input.language === 'en' || input.language === 'fr') return input.language;
  if (!input.parentUserId) return 'en';
  const rows = await database
    .select({ locale: schema.users.locale })
    .from(schema.users)
    .where(eq(schema.users.id, input.parentUserId));
  return rows[0]?.locale.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/**
 * What this household may be told. Flag off does not read the table.
 * A household with no yes does not read anyone else's yes. The other
 * parent's given name is read only after a mutual match, and only for
 * the confirmation line.
 */
export async function prepareSameActivityOffer(
  database: Database,
  input: {
    familyId: string;
    activityKey: string;
    kind: SameActivityKind;
    activity?: string;
    parentUserId?: string;
    language?: ReplyLanguage;
  },
): Promise<
  | { status: 'skipped'; reason: 'flag_off' }
  | { status: 'refused'; reason: 'invalid_activity' }
  | SameActivityDisclosure
> {
  if (!sameActivityMeetEnabled()) return { status: 'skipped', reason: 'flag_off' };
  const activityKey = parseActivityKey(input.activityKey);
  if (!activityKey) return { status: 'refused', reason: 'invalid_activity' };
  const language = await languageFor(database, input);

  const own = await loadCallerOptIn(database, {
    familyId: input.familyId,
    activityKey,
    kind: input.kind,
  });
  if (!own) {
    return {
      status: 'not_opted_in',
      reply: renderSameActivityReply('not_opted_in', { language, activity: input.activity }),
    };
  }

  const cohort = await loadActivityCohort(database, { activityKey, kind: input.kind });
  const match = matchSameActivity(cohort, {
    familyId: input.familyId,
    activityKey,
    kind: input.kind,
  });
  if (match.status === 'mutual' && match.counterpartFamilyIds.length === 1) {
    const counterpartId = match.counterpartFamilyIds[0];
    const rawName = counterpartId
      ? await loadCounterpartGivenName(database, {
          familyId: counterpartId,
          activityKey,
          kind: input.kind,
        })
      : null;
    return {
      status: 'mutual',
      kind: match.kind,
      counterpartFamilyIds: match.counterpartFamilyIds,
      reply: renderSameActivityReply('mutual', {
        language,
        firstName: sameActivityFirstName(rawName) ?? undefined,
      }),
    };
  }
  if (match.status === 'mutual') {
    return {
      status: 'mutual',
      kind: match.kind,
      counterpartFamilyIds: match.counterpartFamilyIds,
      reply: renderSameActivityReply('mutual', { language }),
    };
  }
  return {
    status: 'waiting',
    reply: renderSameActivityReply('waiting', { language }),
  };
}

export type SameActivityAnswer =
  | { status: 'skipped'; reason: 'flag_off' }
  | { status: 'refused'; reason: 'invalid_activity' | 'invalid_message' | 'invalid_kind' }
  | { status: 'unread'; reply: SameActivityReply }
  | {
      status: 'declined';
      recorded: 'revoked' | 'already_off';
      otherSide: { sent: false; skipped: 'decline' };
    }
  | (SameActivityDisclosure & { recorded: 'created' | 'already' });

/**
 * Apply one explicit reply. "no" revokes even when the flag is off and
 * sends nothing to the other household. A yes while the flag is off
 * records nothing and does not look for a match. An unclear body is not
 * a yes and does not read other households.
 */
export async function answerSameActivity(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    activityKey: string;
    messageId: string;
    body: string;
    activity?: string;
    language?: ReplyLanguage;
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
      otherSide: sameActivityDeclineToOtherSide(),
    };
  }

  if (!sameActivityMeetEnabled()) return { status: 'skipped', reason: 'flag_off' };
  if (choice === null) {
    const language = await languageFor(database, {
      language: input.language,
      parentUserId: input.parentUserId,
    });
    return {
      status: 'unread',
      reply: renderSameActivityReply('unread', { language, activity: input.activity }),
    };
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
    parentUserId: input.parentUserId,
    activityKey,
    activity: input.activity,
    kind: choice,
    language: input.language,
  });
  if (disclosure.status === 'skipped' || disclosure.status === 'refused') return disclosure;
  return { ...disclosure, recorded: recorded.status === 'recorded' ? 'created' : 'already' };
}

export { deliverSameActivityReply };
