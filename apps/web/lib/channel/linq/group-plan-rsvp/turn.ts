import type { ReplyLanguage } from '~/lib/channel/language';
import {
  linqGroupPlanRsvpCalendarEnabled,
  linqGroupPlanRsvpEnabled,
  linqGroupPollsEnabled,
} from '../config';
import type { GroupHoldReason } from '../group-audience';
import type { LinqTapback } from '../transport';
import {
  type CalendarConsentReader,
  type CalendarPrivateSender,
  type GroupPlanCalendarWriter,
  type GroupPlanHouseholdResolver,
  hostFamilyIdForPlan,
} from './calendar';
import {
  type CalendarEffect,
  answerPendingCalendarAsk,
  householdWhen,
  settleCalendarAfterAnswer,
} from './calendar-turn';
import { zonedLocalInstant } from '~/lib/plan/spine';
import { placedInstant } from '../group-experience/reading';
import { type PlanRef, planReadViews, refPlanId, resolvePlanKey } from './plan-identity';
import { groupPlanRsvpLineInput, groupPlanWhichLineInput } from './facts';
import { memberKeyFromName, senderMemberKey } from './member-key';
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
import {
  GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE,
  GROUP_PLAN_RSVP_TEMPLATE,
  GroupPlanRsvpHeld,
} from './send';
import type { GroupPlanRecord, GroupPlanRsvpStore } from './store';
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
        | 'group_plan_other_event'
        | 'group_plan_recorded'
        | 'group_plan_spoken'
        | 'group_plan_unread'
        | 'group_plan_line_unsent'
        | 'group_plan_which_asked'
        | 'group_poll_lock_asked'
        | 'group_poll_spoken'
        | 'group_poll_recorded'
        | 'group_poll_unread'
        | 'group_poll_line_unsent'
        | 'group_plan_calendar_written'
        | 'group_plan_calendar_declined'
        | 'group_plan_calendar_asked'
        | 'group_plan_calendar_unwritten';
      count: 'ignored' | 'intake';
      notice?: 'sent' | { skipped: GroupPlanRsvpVoiceSkip | 'not_sent' | GroupHoldReason };
      tally?: PlanTally;
      calendar?: CalendarEffect;
      card?: 'sent' | { skipped: GroupPollCardSkip };
      pollTally?: GroupPollTally;
      /** `group_poll_lock_asked`: the open poll's option key the lock named, when it named one. */
      lockChoice?: string;
      /** The plan this message is about, as code resolved it; later readers bind only to this. */
      planRef?: PlanRef;
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
      outcome.outcome === 'group_plan_which_asked' ||
      outcome.outcome === 'group_poll_spoken' ||
      outcome.outcome === 'group_poll_recorded' ||
      outcome.outcome === 'group_poll_line_unsent' ||
      outcome.outcome === 'group_plan_calendar_written' ||
      outcome.outcome === 'group_plan_calendar_declined' ||
      outcome.outcome === 'group_plan_calendar_asked' ||
      outcome.outcome === 'group_plan_calendar_unwritten')
  );
}

/** A group line and, by id, the household and plan it is about. */
export interface GroupPlanLine {
  chatId: string;
  text: string;
  kind?: 'plan' | 'poll';
  /** The household that owns the plan or poll: its ledger row is theirs. */
  familyId: string;
  /** The plan the line is about, when it is about one: a reaction on it is about that plan. */
  planId?: string | null;
}

export interface GroupPlanRsvpTurnInput {
  chatId: string;
  senderHandle: string;
  senderName: string | null;
  text: string;
  tapback: LinqTapback | null;
  /** The message a tapback landed on. Absent for a plain text. */
  tapbackMessageId?: string | null;
  /** Verified Hale user for this handle, when inbound resolved one. */
  senderUserId?: string | null;
  /** Language for the group line. Calendar lines use {@link calendarLanguage}. */
  language: ReplyLanguage;
  /**
   * Stored household language for a private calendar line, or null when none is
   * stored. Absent means the tests' turn language. Null is not English.
   */
  calendarLanguage?: ReplyLanguage | null;
  /** The asking household's zone, so the reader can place a time. Null or absent: unknown. */
  timeZone?: string | null;
  now: Date;
  /** VIL-686: Secret Santa runs in this chat; its asks are not a plan. */
  secretSanta?: boolean;
}

export interface GroupPlanRsvpTurnDeps {
  store: GroupPlanRsvpStore;
  reader?: GroupPlanRsvpReader;
  composer?: GroupPlanRsvpComposer;
  /** One group line, ledgered on the household that owns the plan or poll it is about. */
  send: (input: GroupPlanLine) => Promise<{ providerMessageId: string }>;
  /** Plan RSVPs (LINQ_GROUP_PLAN_RSVP_ENABLED). */
  enabled?: () => boolean;
  /** Calendar copy after an OK (LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED). Default off. */
  calendarEnabled?: () => boolean;
  households?: GroupPlanHouseholdResolver;
  calendar?: GroupPlanCalendarWriter;
  consentReader?: CalendarConsentReader;
  /** 1:1 calendar lines. Never the group chat. */
  privateSend?: CalendarPrivateSender;
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

/**
 * An instant the reader named. An ISO time with its offset is taken as is; a wall-clock time
 * with no offset is placed on the household's own zone, never the server's. No zone, no time.
 */
export function instantOnClock(
  value: string | null | undefined,
  timeZone: string | null,
): Date | null {
  const placed = placedInstant(value);
  if (placed) return new Date(placed);
  const wall = value?.trim().match(WALL_CLOCK);
  const day = wall?.[1];
  const time = wall?.[2];
  if (!day || !time || !timeZone) return null;
  // A wall clock that names no real day (the model's own slip) places nothing.
  if (Number.isNaN(Date.parse(`${day}T${time}:00Z`))) return null;
  try {
    return zonedLocalInstant(day, time, timeZone);
  } catch (err) {
    // A zone name the platform does not know places nothing.
    if (err instanceof RangeError) return null;
    throw err;
  }
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/** The calendar ask, among the open plans, that this household still has to answer: one, or none. */
async function pendingAskPlan(
  deps: GroupPlanRsvpTurnDeps,
  input: { chatId: string; userId: string | null; tapbackMessageId?: string | null },
  open: readonly GroupPlanRecord[],
): Promise<GroupPlanRecord | null> {
  if (input.tapbackMessageId) {
    const found = await deps.store.findCalendarAskByMessage(input.tapbackMessageId);
    return found ? (open.find((plan) => plan.id === found.plan.id) ?? null) : null;
  }
  if (!deps.households || !input.userId) return null;
  const home = await deps.households.resolve({ chatId: input.chatId, userId: input.userId });
  if (home.status !== 'one') return null;
  const pending: GroupPlanRecord[] = [];
  for (const plan of open) {
    const row = await deps.store.loadCalendarConsent(plan.id, home.familyId);
    if (row && (row.status === 'asked' || row.status === 'declined')) pending.push(plan);
  }
  return pending.length === 1 ? (pending[0] ?? null) : null;
}

export async function takeGroupPlanRsvpTurn(
  input: GroupPlanRsvpTurnInput,
  deps: GroupPlanRsvpTurnDeps,
): Promise<GroupPlanRsvpTurnOutcome> {
  const rsvpOn = (deps.enabled ?? linqGroupPlanRsvpEnabled)();
  const pollsOn = (deps.pollsEnabled ?? linqGroupPollsEnabled)();
  if (!rsvpOn && !pollsOn) return { handled: false };

  const open = rsvpOn ? await deps.store.listOpenPlans(input.chatId, input.now) : [];
  const livePoll = pollsOn ? await deps.store.loadLivePoll(input.chatId) : null;
  const reader = deps.reader ?? sharedGroupPlanRsvpReader();
  const seated = await deps.store.seatedExpected(input.chatId);
  const tallies = new Map<string, Awaited<ReturnType<GroupPlanRsvpStore['loadTally']>>>();
  for (const plan of open) tallies.set(plan.id, await deps.store.loadTally(plan.id));
  const somethingLive = open.length > 0 || Boolean(livePoll);
  const calendarOn = rsvpOn && (deps.calendarEnabled ?? linqGroupPlanRsvpCalendarEnabled)();
  const calendarLanguage =
    input.calendarLanguage === undefined ? input.language : input.calendarLanguage;
  const senderKey = await senderMemberKey(
    { handle: input.senderHandle, name: input.senderName },
    async () => [
      ...[...tallies.values()].flatMap((loaded) =>
        [...loaded.rows, ...loaded.expected].map((row) => row.memberKey),
      ),
      ...(livePoll ? await deps.store.pollVoterKeys(livePoll.id) : []),
    ],
  );
  const senderSeat = seated.find((person) => person.memberKey === senderKey);
  const displayName = input.senderName?.trim() || senderSeat?.displayName || 'someone';
  const calendarUserId = input.senderUserId ?? senderSeat?.userId ?? null;

  const askPlan =
    calendarOn && open.length > 0
      ? await pendingAskPlan(
          deps,
          {
            chatId: input.chatId,
            userId: calendarUserId,
            tapbackMessageId: input.tapbackMessageId,
          },
          open,
        )
      : null;
  if (askPlan) {
    const answered = await answerPendingCalendarAsk(
      {
        chatId: input.chatId,
        plan: askPlan,
        userId: calendarUserId,
        senderName: input.senderName,
        text: input.text,
        tapback: input.tapback,
        tapbackMessageId: input.tapbackMessageId,
        language: calendarLanguage,
        now: input.now,
      },
      {
        store: deps.store,
        households: deps.households,
        calendar: deps.calendar,
        consentReader: deps.consentReader,
        composer: deps.composer,
        privateSend: deps.privateSend,
      },
    );
    if (answered.consumed) {
      const tally = (await deps.store.loadTally(askPlan.id)).tally;
      const outcome =
        answered.kind === 'written'
          ? 'group_plan_calendar_written'
          : answered.kind === 'declined'
            ? 'group_plan_calendar_declined'
            : answered.kind === 'asked'
              ? 'group_plan_calendar_asked'
              : 'group_plan_calendar_unwritten';
      return {
        handled: true,
        outcome,
        count: answered.notice === 'sent' ? 'intake' : 'ignored',
        ...(answered.notice ? { notice: answered.notice } : {}),
        tally,
        calendar: answered.effect,
      };
    }
  }

  const tapped = input.tapback && !input.text.trim();
  const reading = await reader.read({
    text: input.text,
    tapback: input.tapback,
    senderName: input.senderName,
    plans: planReadViews(
      open.map((plan) => ({ plan, tally: tallies.get(plan.id)?.tally ?? null })),
    ),
    recent: [],
    ...(pollsOn ? { polls: { live: livePoll ? pollReadView(livePoll) : null } } : {}),
    ...(input.secretSanta ? { secretSanta: true as const } : {}),
    clock: input.timeZone ? { now: input.now.toISOString(), timeZone: input.timeZone } : null,
  });

  // An answer or count ask spoken to Hale that could be about more than one open plan binds
  // nothing; Hale asks which. The reader may mark it low confidence for that very doubt, and
  // asking changes no state, so the doubt about the plan does not silence the ask.
  if (
    reading &&
    !tapped &&
    open.length > 1 &&
    reading.addressed &&
    resolvePlanKey(reading.planKey, open).status === 'unclear' &&
    (reading.intent === 'rsvp' || reading.intent === 'edit' || reading.intent === 'ask_tally')
  ) {
    return askWhichPlan(input, deps, open);
  }

  if (!reading || reading.confidence !== 'high') {
    if (!somethingLive) return { handled: false };
    return {
      handled: true,
      outcome: open.length > 0 ? 'group_plan_unread' : 'group_poll_unread',
      count: 'ignored',
    };
  }

  // The plan this message is about, by an id code resolved: the Hale line a tapback landed on,
  // or the open plan whose key the reader named. Never the only, or the newest, open plan.
  const ref: PlanRef = tapped
    ? await tapbackPlanRef(deps, input, open)
    : resolvePlanKey(reading.planKey, open);

  if (reading.intent === 'chatter' || reading.intent === 'unclear') {
    if (!somethingLive) return { handled: false };
    return { handled: true, outcome: 'group_plan_chatter', count: 'ignored', planRef: ref };
  }

  if (isGroupPollIntent(reading.intent)) {
    if (!pollsOn) {
      if (!somethingLive) return { handled: false };
      return { handled: true, outcome: 'group_plan_chatter', count: 'ignored', planRef: ref };
    }
    // A poll's ledger household is chosen the way a plan's is: the asker's own household
    // here, else the family that claimed the chat. A chat several families share has polls.
    const pollFamilyId =
      reading.intent === 'start_poll'
        ? await hostFamilyIdForPlan(
            deps.households,
            await deps.store.coveringFamily(input.chatId),
            {
              chatId: input.chatId,
              userId: input.senderUserId,
            },
          )
        : null;
    const polled = await takeGroupPollReading(
      reading,
      {
        chatId: input.chatId,
        language: input.language,
        now: input.now,
        livePoll,
        planId: refPlanId(ref),
        pollFamilyId,
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
    return polled.handled ? { ...polled, planRef: ref } : polled;
  }

  if (!rsvpOn) {
    if (!somethingLive) return { handled: false };
    return { handled: true, outcome: 'group_plan_chatter', count: 'ignored', planRef: ref };
  }

  let plan: GroupPlanRecord | null =
    ref.status === 'plan' ? (open.find((row) => row.id === ref.planId) ?? null) : null;
  const aboutOpenPlan = plan !== null;
  if (
    reading.intent === 'start_tracking' &&
    !plan &&
    (ref.status === 'other' || open.length === 0)
  ) {
    const cover = await deps.store.coveringFamily(input.chatId);
    const familyId = await hostFamilyIdForPlan(deps.households, cover, {
      chatId: input.chatId,
      userId: input.senderUserId,
    });
    const title = reading.planTitle?.trim();
    if (!familyId || !title) return { handled: false };
    const replaces = resolvePlanKey(reading.replacesPlanKey, open);
    plan = await deps.store.createPlan({
      chatId: input.chatId,
      familyId,
      title,
      startsAt: instantOnClock(reading.startsAt, input.timeZone ?? null),
      location: reading.location,
      rsvpDeadlineAt: instantOnClock(reading.deadline, input.timeZone ?? null),
      createdByUserId: input.senderUserId ?? null,
      expected: seated,
      now: input.now,
      replacesPlanId: refPlanId(replaces),
    });
  }

  if (!plan) {
    if (!somethingLive) return { handled: false };
    // Not tied by id to any open plan: no later reader of this message may bind it to one.
    return { handled: true, outcome: 'group_plan_other_event', count: 'ignored', planRef: ref };
  }

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
    before: aboutOpenPlan ? before : null,
    after,
    householdAnswer,
  });
  const finishCalendar = async () => {
    if (
      !calendarOn ||
      (reading.intent !== 'rsvp' && reading.intent !== 'edit') ||
      !reading.response
    ) {
      return undefined;
    }
    return settleCalendarAfterAnswer(
      {
        chatId: input.chatId,
        plan,
        userId: calendarUserId,
        memberKey: senderKey,
        displayName,
        householdLabel: reading.householdLabel,
        response: reading.response,
        language: calendarLanguage,
        parentWords: input.text.trim() || null,
        now: input.now,
      },
      {
        store: deps.store,
        households: deps.households,
        calendar: deps.calendar,
        consentReader: deps.consentReader,
        composer: deps.composer,
        privateSend: deps.privateSend,
      },
    );
  };

  if (!speak) {
    const calendar = await finishCalendar();
    return {
      handled: true,
      outcome: 'group_plan_recorded',
      count: 'ignored',
      tally: after,
      ...(calendar ? { calendar } : {}),
    };
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
    const calendar = await finishCalendar();
    return {
      handled: true,
      outcome: 'group_plan_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
      tally: after,
      ...(calendar ? { calendar } : {}),
    };
  }

  try {
    await deps.send({
      chatId: input.chatId,
      text: spoken.line,
      kind: 'plan',
      familyId: plan.familyId,
      planId: plan.id,
    });
  } catch (err) {
    console.error(
      {
        err: err instanceof Error ? err.name : 'unknown',
        reason: err instanceof GroupPlanRsvpHeld ? err.reason : undefined,
      },
      'group plan rsvp: send failed',
    );
    const calendar = await finishCalendar();
    return {
      handled: true,
      outcome: 'group_plan_line_unsent',
      count: 'ignored',
      notice: { skipped: err instanceof GroupPlanRsvpHeld ? err.reason : 'not_sent' },
      tally: after,
      ...(calendar ? { calendar } : {}),
    };
  }

  const calendar = await finishCalendar();
  return {
    handled: true,
    outcome: 'group_plan_spoken',
    count: 'intake',
    notice: 'sent',
    tally: after,
    ...(calendar ? { calendar } : {}),
  };
}

/** The plan of the Hale plan line a reaction landed on, while it is still open here. */
async function tapbackPlanRef(
  deps: GroupPlanRsvpTurnDeps,
  input: GroupPlanRsvpTurnInput,
  open: readonly GroupPlanRecord[],
): Promise<PlanRef> {
  if (!input.tapbackMessageId) return { status: 'none' };
  const planId = await deps.store.planOfGroupLine(input.chatId, input.tapbackMessageId, [
    GROUP_PLAN_RSVP_TEMPLATE,
    GROUP_PLAN_RSVP_FOLLOWUP_TEMPLATE,
  ]);
  const plan = planId ? open.find((row) => row.id === planId) : undefined;
  return plan ? { status: 'plan', planId: plan.id } : { status: 'none' };
}

/**
 * The message spoke to Hale about a plan, but it could be more than one open plan: one
 * model-written group line asking which, naming them. Nothing is recorded on any plan. The
 * line is the asker's own household's (it is about no single plan), or nothing is sent.
 */
async function askWhichPlan(
  input: GroupPlanRsvpTurnInput,
  deps: GroupPlanRsvpTurnDeps,
  open: readonly GroupPlanRecord[],
): Promise<GroupPlanRsvpTurnOutcome> {
  const familyId = await hostFamilyIdForPlan(
    deps.households,
    await deps.store.coveringFamily(input.chatId),
    { chatId: input.chatId, userId: input.senderUserId },
  );
  if (!familyId) {
    console.info(
      { outcome: 'group_plan_which_unsent', reason: 'asker_unknown' },
      'group plan rsvp: which-plan ask has no household to ledger it, nothing sent',
    );
    return {
      handled: true,
      outcome: 'group_plan_other_event',
      count: 'ignored',
      planRef: { status: 'unclear' },
    };
  }
  const spoken = await composeGroupPlanRsvpLine(
    groupPlanWhichLineInput({
      language: input.language,
      choices: open.map((plan) => ({
        title: plan.title,
        startsAt: householdWhen(plan.startsAt, input.timeZone ?? null),
      })),
    }),
    deps.composer ?? productionGroupPlanRsvpComposer(),
  );
  if (spoken.status === 'skipped') {
    console.warn(
      { outcome: 'group_plan_which_unsent', reason: spoken.reason },
      'group plan rsvp: which-plan ask not written',
    );
    return {
      handled: true,
      outcome: 'group_plan_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
      planRef: { status: 'unclear' },
    };
  }
  try {
    await deps.send({ chatId: input.chatId, text: spoken.line, kind: 'plan', familyId });
  } catch (err) {
    console.error(
      {
        err: err instanceof Error ? err.name : 'unknown',
        reason: err instanceof GroupPlanRsvpHeld ? err.reason : undefined,
      },
      'group plan rsvp: which-plan ask send failed',
    );
    return {
      handled: true,
      outcome: 'group_plan_line_unsent',
      count: 'ignored',
      notice: { skipped: err instanceof GroupPlanRsvpHeld ? err.reason : 'not_sent' },
      planRef: { status: 'unclear' },
    };
  }
  return {
    handled: true,
    outcome: 'group_plan_which_asked',
    count: 'intake',
    notice: 'sent',
    planRef: { status: 'unclear' },
  };
}
