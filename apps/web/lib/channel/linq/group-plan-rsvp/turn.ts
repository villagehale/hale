import type { ReplyLanguage } from '~/lib/channel/language';
import { linqGroupPlanRsvpEnabled, linqGroupPollsEnabled } from '../config';
import type { LinqTapback } from '../transport';
import { groupPlanRsvpLineInput } from './facts';
import { memberKeyFromHandle, memberKeyFromName } from './member-key';
import type { GroupPollTally } from './poll-tally';
import {
  type GroupPollCardPort,
  type GroupPollCardSkip,
  pollReadView,
  takeGroupPollReading,
} from './poll-turn';
import {
  type GroupPlanRsvpReader,
  type GroupPlanRsvpReading,
  isGroupPollIntent,
  sharedGroupPlanRsvpReader,
} from './reading';
import type { GroupPlanRsvpStore } from './store';
import { type PlanTally, isMeaningfulTallyChange } from './tally';
import {
  type GroupPlanRsvpComposer,
  type GroupPlanRsvpVoiceSkip,
  composeGroupPlanRsvpLine,
  productionGroupPlanRsvpComposer,
} from './voice';

/**
 * VIL-442 (T15) — one inbound turn against a group plan.
 *
 * Works for seated Hale customers and for people who never signed up (Instinct
 * #1). Banter is recorded as chatter and Hale stays quiet. Tapbacks and free
 * text are votes. Hale speaks only at settle points, in model-written words.
 *
 * VIL-471 — the same read also covers group polls (`LINQ_GROUP_POLLS_ENABLED`):
 * a poll intent goes to `poll-turn.ts`. Either flag alone runs the turn; the
 * other half stays dark.
 */

export type GroupPlanRsvpTurnOutcome =
  | { handled: false }
  | {
      handled: true;
      outcome:
        | 'group_plan_chatter'
        | 'group_plan_recorded'
        | 'group_plan_spoken'
        | 'group_plan_unread'
        | 'group_plan_line_unsent'
        | 'group_poll_spoken'
        | 'group_poll_recorded'
        | 'group_poll_unread'
        | 'group_poll_line_unsent';
      count: 'ignored' | 'intake';
      notice?: 'sent' | { skipped: GroupPlanRsvpVoiceSkip | 'not_sent' };
      tally?: PlanTally;
      card?: 'sent' | { skipped: GroupPollCardSkip };
      pollTally?: GroupPollTally;
    };

/** Banter and a missed read stay quiet without stealing the rest of the group door. */
export function groupPlanRsvpTakesTheTurn(
  outcome: GroupPlanRsvpTurnOutcome,
): outcome is Extract<GroupPlanRsvpTurnOutcome, { handled: true }> {
  return (
    outcome.handled &&
    (outcome.outcome === 'group_plan_spoken' ||
      outcome.outcome === 'group_plan_recorded' ||
      outcome.outcome === 'group_plan_line_unsent' ||
      outcome.outcome === 'group_poll_spoken' ||
      outcome.outcome === 'group_poll_recorded' ||
      outcome.outcome === 'group_poll_line_unsent')
  );
}

export interface GroupPlanRsvpTurnInput {
  chatId: string;
  senderHandle: string;
  senderName: string | null;
  text: string;
  tapback: LinqTapback | null;
  language: ReplyLanguage;
  now: Date;
}

export interface GroupPlanRsvpTurnDeps {
  store: GroupPlanRsvpStore;
  reader?: GroupPlanRsvpReader;
  composer?: GroupPlanRsvpComposer;
  send: (input: {
    chatId: string;
    text: string;
    kind?: 'plan' | 'poll';
  }) => Promise<{ providerMessageId: string }>;
  /** Plan RSVPs (LINQ_GROUP_PLAN_RSVP_ENABLED). */
  enabled?: () => boolean;
  /** Group polls (LINQ_GROUP_POLLS_ENABLED). */
  pollsEnabled?: () => boolean;
  /** The native poll card. Absent is named on the outcome (`no_card_port`), never silent. */
  pollCard?: GroupPollCardPort;
}

function coversKeysFor(
  reading: GroupPlanRsvpReading,
  expected: readonly { memberKey: string; displayName: string }[],
): string[] {
  const keys: string[] = [];
  for (const name of reading.coversNames) {
    const folded = name.trim().toLowerCase();
    if (!folded) continue;
    const match = expected.find((person) => person.displayName.trim().toLowerCase() === folded);
    if (match) keys.push(match.memberKey);
    else keys.push(memberKeyFromName(name));
  }
  return keys;
}

export async function takeGroupPlanRsvpTurn(
  input: GroupPlanRsvpTurnInput,
  deps: GroupPlanRsvpTurnDeps,
): Promise<GroupPlanRsvpTurnOutcome> {
  const rsvpOn = (deps.enabled ?? linqGroupPlanRsvpEnabled)();
  const pollsOn = (deps.pollsEnabled ?? linqGroupPollsEnabled)();
  if (!rsvpOn && !pollsOn) return { handled: false };

  const live = rsvpOn ? await deps.store.loadLivePlan(input.chatId) : null;
  const livePoll = pollsOn ? await deps.store.loadLivePoll(input.chatId) : null;
  const reader = deps.reader ?? sharedGroupPlanRsvpReader();
  const seated = await deps.store.seatedExpected(input.chatId);
  const liveTally = live ? await deps.store.loadTally(live.id) : null;
  const somethingLive = Boolean(live || livePoll);

  const reading = await reader.read({
    text: input.text,
    tapback: input.tapback,
    senderName: input.senderName,
    plan: live
      ? {
          title: live.title,
          deadline: live.rsvpDeadlineAt?.toISOString() ?? null,
          yesNames: liveTally?.tally.yesNames ?? [],
          waitingNames: liveTally?.tally.waitingNames ?? [],
        }
      : null,
    recent: [],
    ...(pollsOn ? { polls: { live: livePoll ? pollReadView(livePoll) : null } } : {}),
  });

  if (!reading || reading.confidence !== 'high') {
    if (!somethingLive) return { handled: false };
    return {
      handled: true,
      outcome: live ? 'group_plan_unread' : 'group_poll_unread',
      count: 'ignored',
    };
  }

  if (reading.intent === 'chatter' || reading.intent === 'unclear') {
    if (!somethingLive) return { handled: false };
    return { handled: true, outcome: 'group_plan_chatter', count: 'ignored' };
  }

  const senderKey =
    memberKeyFromHandle(input.senderHandle) ??
    memberKeyFromName(input.senderName ?? input.senderHandle);
  const senderSeat = seated.find((person) => person.memberKey === senderKey);
  const displayName = input.senderName?.trim() || senderSeat?.displayName || 'someone';

  if (isGroupPollIntent(reading.intent)) {
    if (!pollsOn) {
      if (!somethingLive) return { handled: false };
      return { handled: true, outcome: 'group_plan_chatter', count: 'ignored' };
    }
    return takeGroupPollReading(
      reading,
      {
        chatId: input.chatId,
        language: input.language,
        now: input.now,
        livePoll,
        seated,
        voter: {
          memberKey: senderKey,
          displayName,
          userId: senderSeat?.userId ?? null,
          haleCustomer: senderSeat?.haleCustomer ?? false,
        },
      },
      {
        store: deps.store,
        composer: deps.composer,
        send: (line) => deps.send(line),
        card: deps.pollCard,
      },
    );
  }

  if (!rsvpOn) {
    if (!somethingLive) return { handled: false };
    return { handled: true, outcome: 'group_plan_chatter', count: 'ignored' };
  }

  let plan = live;
  if (reading.intent === 'start_tracking') {
    if (!plan) {
      const cover = await deps.store.coveringFamily(input.chatId);
      const title = reading.planTitle?.trim();
      if (!cover || !title) return { handled: false };
      plan = await deps.store.createPlan({
        chatId: input.chatId,
        familyId: cover.familyId,
        title,
        startsAt: reading.startsAt ? new Date(reading.startsAt) : null,
        location: reading.location,
        rsvpDeadlineAt: reading.deadline ? new Date(reading.deadline) : null,
        createdByUserId: null,
        expected: seated,
        now: input.now,
      });
    }
  }

  if (!plan) return { handled: false };

  const before = (await deps.store.loadTally(plan.id)).tally;

  if (reading.intent === 'rsvp' || reading.intent === 'edit') {
    if (!reading.response) {
      return { handled: true, outcome: 'group_plan_unread', count: 'ignored' };
    }
    await deps.store.addExpected(plan.id, {
      memberKey: senderKey,
      displayName,
      userId: senderSeat?.userId ?? null,
      haleCustomer: senderSeat?.haleCustomer ?? false,
    });
    const household = Boolean(reading.householdLabel || reading.coversNames.length > 0);
    await deps.store.upsertRsvp({
      planId: plan.id,
      memberKey: senderKey,
      displayName,
      householdLabel: reading.householdLabel,
      userId: senderSeat?.userId ?? null,
      haleCustomer: senderSeat?.haleCustomer ?? false,
      response: reading.response,
      headcount: reading.headcount,
      source: household ? 'on_behalf' : input.tapback ? 'tapback' : 'text',
      coversKeys: coversKeysFor(reading, [...seated, { memberKey: senderKey, displayName }]),
      verbatim: input.text.trim() || null,
      now: input.now,
    });
  }

  const afterLoad = await deps.store.loadTally(plan.id);
  const after = afterLoad.tally;
  const householdAnswer = Boolean(reading.householdLabel || reading.coversNames.length > 0);
  const speak = isMeaningfulTallyChange({
    intent: reading.intent,
    before: live ? before : null,
    after,
    householdAnswer,
  });

  if (!speak) {
    return { handled: true, outcome: 'group_plan_recorded', count: 'ignored', tally: after };
  }

  const kind = reading.intent === 'start_tracking' ? 'tracking_started' : 'tally';
  const spoken = await composeGroupPlanRsvpLine(
    groupPlanRsvpLineInput({
      kind,
      language: input.language,
      title: plan.title,
      deadline: plan.rsvpDeadlineAt?.toISOString() ?? null,
      tally: after,
    }),
    deps.composer ?? productionGroupPlanRsvpComposer(),
  );
  if (spoken.status === 'skipped') {
    console.warn(
      { outcome: 'group_plan_line_unsent', reason: spoken.reason },
      'group plan rsvp: line not sent',
    );
    return {
      handled: true,
      outcome: 'group_plan_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
      tally: after,
    };
  }

  try {
    await deps.send({ chatId: input.chatId, text: spoken.line, kind: 'plan' });
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'group plan rsvp: send failed',
    );
    return {
      handled: true,
      outcome: 'group_plan_line_unsent',
      count: 'ignored',
      notice: { skipped: 'not_sent' },
      tally: after,
    };
  }

  return {
    handled: true,
    outcome: 'group_plan_spoken',
    count: 'intake',
    notice: 'sent',
    tally: after,
  };
}
