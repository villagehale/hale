import { type Database, schema } from '@hale/db';
import { and, eq, notInArray } from 'drizzle-orm';
import { groupJoinIntroEnabled, groupMailNoticeEnabled } from './config';
import {
  type GroupJoinIntroAudience,
  type GroupJoinIntroClaim,
  groupJoinIntroClaims,
} from './group-onboarding-line-input';
import { type GroupLineOutcome, sendGroupOnboardingLine } from './group-onboarding-voice';
import { linqGroupTurnAiEnabled } from './group-turn-reader';
import {
  type RosterAskOutcome,
  type RosterVoicePorts,
  askRoster,
  familyVoice,
  knownParentName,
  markRosterAsked,
  readRosterByChat,
} from './roster-ask';

/**
 * VIL-727 — Hale's ground rules, said once when it joins a group.
 *
 * Lit (`GROUP_JOIN_INTRO_ENABLED`), the line Hale says when it joins a household group is
 * the join intro: who it is, whose family it is there for, the ground rules that are true
 * today, and, when someone in the chat has not been asked yet, who they are. The ask rides
 * in the intro, so the roster bookkeeping (members asked, `asked_at`, the
 * `linq_group_roster_asked` row) follows it exactly as it follows `roster_ask`. A group
 * where everyone is already known, where dark says nothing, gets the intro with no ask.
 *
 * The model writes every word (skill `group-join-intro`, through the onboarding composer)
 * and code owns the facts. A claim the shipped behaviour does not make true is left out of
 * the facts ({@link liveGroupJoinIntroClaims}). A line the model cannot write is retried
 * once, then nothing is sent: `group_line_unsent` is audited and Slack #ops is paged. There
 * is no fallback sentence. A group several families share gets the same intro from
 * `noticeSharedGroupAdded` (multi-family.ts), with no household named.
 *
 * Once per join: the dedupe key carries the roster's `roster_fetched_at`, which only a
 * settle writes. An open roster settles once per join: a re-add after an eject rebuilds it,
 * and a `roster_pending`, `refused` or `no_family` roster that settles later never had an
 * intro to repeat. Dark, every caller gets today's `askRoster`, unchanged.
 */

export const GROUP_JOIN_INTRO_TEMPLATE = 'linq:group_join_intro';

const OPEN: readonly schema.LinqGroupRosterStatus[] = ['roles_proposed', 'partial', 'confirmed'];
const GONE: schema.LinqRosterMemberStatus[] = ['left', 'removed'];

/** One intro per chat per join. A roster settles once per join, and its settle time keys it. */
export function groupJoinIntroDedupeKey(chatId: string, rosterFetchedAt: Date | null): string {
  return `${GROUP_JOIN_INTRO_TEMPLATE}:${chatId}:${rosterFetchedAt?.toISOString() ?? 'unsettled'}`;
}

/** The claims that are true right now: {@link groupJoinIntroClaims} over the live flags. */
export function liveGroupJoinIntroClaims(input: {
  audience: GroupJoinIntroAudience;
  otherPeople: number;
}): GroupJoinIntroClaim[] {
  return groupJoinIntroClaims({
    ...input,
    turnReaderLive: linqGroupTurnAiEnabled(),
    mailNoticeLive: groupMailNoticeEnabled(),
  });
}

export type GroupJoinIntroOutcome =
  | { outcome: 'group_intro_sent'; asked: number; notice: GroupLineOutcome }
  | { outcome: 'group_intro_already' }
  | { outcome: 'group_intro_not_sent'; notice: GroupLineOutcome }
  | { outcome: 'group_intro_not_ready'; status: schema.LinqGroupRosterStatus | null }
  | { outcome: 'no_primary_parent' };

/**
 * The household intro for the chat's current join. It asks who people are only when a
 * member has not been asked yet; nobody is seated here, and a seat still waits for each
 * person's own reply.
 */
export async function introduceHouseholdGroup(
  database: Database,
  input: { chatId: string } & RosterVoicePorts,
): Promise<GroupJoinIntroOutcome> {
  const roster = await readRosterByChat(database, input.chatId);
  if (!roster?.familyId || !OPEN.includes(roster.status)) {
    return { outcome: 'group_intro_not_ready', status: roster?.status ?? null };
  }
  const family = await familyVoice(database, roster);
  if (!family) return { outcome: 'no_primary_parent' };

  const live = await database
    .select({ status: schema.linqGroupRosterMembers.status })
    .from(schema.linqGroupRosterMembers)
    .where(
      and(
        eq(schema.linqGroupRosterMembers.rosterId, roster.id),
        notInArray(schema.linqGroupRosterMembers.status, GONE),
      ),
    );
  const unasked = live.filter((member) => member.status === 'proposed').length;
  const notice = await sendGroupOnboardingLine(database, {
    ...family,
    chatId: input.chatId,
    request: {
      kind: 'join_intro',
      audience: 'household',
      knownParentName: await knownParentName(database, roster, family.ledgerUserId),
      adderName: null,
      claims: liveGroupJoinIntroClaims({ audience: 'household', otherPeople: live.length }),
      ask: unasked > 0 ? 'who_in_family' : 'none',
    },
    templateKey: GROUP_JOIN_INTRO_TEMPLATE,
    dedupeKey: groupJoinIntroDedupeKey(input.chatId, roster.rosterFetchedAt),
    now: input.now,
    voice: input.voice,
    send: input.send,
  });
  if (notice.outcome === 'already_sent') return { outcome: 'group_intro_already' };
  if (notice.outcome !== 'sent') return { outcome: 'group_intro_not_sent', notice };
  if (unasked === 0) return { outcome: 'group_intro_sent', asked: 0, notice };
  const asked = await markRosterAsked(database, {
    rosterId: roster.id,
    familyId: family.familyId,
    now: input.now,
    source: notice.source,
    via: 'join_intro',
  });
  return { outcome: 'group_intro_sent', asked, notice };
}

/**
 * The line Hale says when it joins a household group, by flag. Dark is today's roster ask;
 * lit is the join intro, which carries that ask when someone needs asking.
 */
export async function introduceOrAskRoster(
  database: Database,
  input: { chatId: string } & RosterVoicePorts,
): Promise<RosterAskOutcome | GroupJoinIntroOutcome> {
  if (!groupJoinIntroEnabled()) return askRoster(database, input);
  return introduceHouseholdGroup(database, input);
}

/** Whether that line asked the roster, so the turn that set it off was answered by it. */
export function rosterWasAsked(said: RosterAskOutcome | GroupJoinIntroOutcome): boolean {
  return said.outcome === 'roster_asked' || (said.outcome === 'group_intro_sent' && said.asked > 0);
}
