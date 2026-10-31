import type { ReplyLanguage } from '~/lib/channel/language';
import { type GroupPollVoiceKind, groupPollLineInput } from './poll-facts';
import type { GroupPollRecord, NativeCardOption } from './poll-store';
import {
  GROUP_POLL_MAX_OPTIONS,
  type GroupPollTally,
  isPollSettlePoint,
  optionKeyAt,
  tallyGroupPoll,
} from './poll-tally';
import type { GroupPlanRsvpReading, GroupPollReadView } from './reading';
import type { ExpectedPerson, GroupPlanRsvpStore } from './store';
import {
  type GroupPlanRsvpComposer,
  type GroupPlanRsvpVoiceSkip,
  composeGroupPlanRsvpLine,
  productionGroupPlanRsvpComposer,
} from './voice';

/**
 * VIL-471 — polls in a Linq group, inside the VIL-442 group turn.
 *
 * A parent asks Hale for a poll in their own words; the shared group reader
 * returns the question and the choices. Anyone in the chat votes — by tapping
 * a native card (when LINQ_POLLS is on) or by saying it in any language, which
 * the same reader resolves to an opaque option key. Code counts keys. It never
 * compares a message to an option.
 *
 * Votes on the VIL-458 stuck-group card (`pollKind: 'group_stuck'`) count here
 * too: the first vote adopts that card as the chat's live poll.
 *
 * Hale speaks at settle points only — the poll opening, someone asking where it
 * stands, or the last person it was waiting on picking — and every line is
 * written by the model from facts. A line the model cannot write sends nothing.
 */

export const GROUP_POLL_KIND = 'group_poll';
/** The VIL-458 stuck-group offer card (`group-poll-offer.ts`, PR #935). */
export const GROUP_STUCK_POLL_KIND = 'group_stuck';
export const GROUP_POLL_CHOICE_KIND = 'group_poll_option';

export function isGroupPollCardKind(pollKind: string | null): boolean {
  return pollKind === GROUP_POLL_KIND || pollKind === GROUP_STUCK_POLL_KIND;
}

export type GroupPollCardSkip = 'polls_off' | 'not_configured' | 'refused' | 'no_card_port';

export interface GroupPollCardPort {
  /** Whether a native card can go out at all (LINQ_POLLS). Read before the line is written. */
  enabled(): boolean;
  send(input: {
    chatId: string;
    familyId: string;
    pollId: string;
    options: readonly { key: string; text: string }[];
    now: Date;
  }): Promise<
    | { status: 'sent'; providerMessageId: string; options: NativeCardOption[] }
    | { status: 'skipped'; reason: Exclude<GroupPollCardSkip, 'no_card_port'> }
  >;
}

export type GroupPollTurnResult = {
  handled: true;
  outcome:
    | 'group_poll_spoken'
    | 'group_poll_recorded'
    | 'group_poll_unread'
    | 'group_poll_line_unsent';
  count: 'ignored' | 'intake';
  notice?: 'sent' | { skipped: GroupPlanRsvpVoiceSkip | 'not_sent' };
  card?: 'sent' | { skipped: GroupPollCardSkip };
  pollTally?: GroupPollTally;
};

export interface GroupPollTurnDeps {
  store: GroupPlanRsvpStore;
  composer?: GroupPlanRsvpComposer;
  send: (input: {
    chatId: string;
    text: string;
    kind: 'poll';
  }) => Promise<{ providerMessageId: string }>;
  card?: GroupPollCardPort;
}

export interface GroupPollVoter {
  memberKey: string;
  displayName: string;
  userId: string | null;
  haleCustomer: boolean;
}

export function pollReadView(poll: GroupPollRecord): GroupPollReadView {
  return {
    question: poll.question,
    options: poll.options.map((option) => ({ key: option.key, text: option.text })),
  };
}

function expectedOf(seated: readonly ExpectedPerson[]) {
  return seated.map((person) => ({ memberKey: person.memberKey, displayName: person.displayName }));
}

/** The model's choices, trimmed and de-duplicated as returned. At most six. */
function choicesOf(reading: GroupPlanRsvpReading): string[] {
  const out: string[] = [];
  for (const raw of reading.pollOptions ?? []) {
    const text = raw.trim();
    if (!text || out.includes(text)) continue;
    out.push(text);
    if (out.length === GROUP_POLL_MAX_OPTIONS) break;
  }
  return out;
}

async function speakPoll(
  deps: GroupPollTurnDeps,
  input: {
    chatId: string;
    kind: GroupPollVoiceKind;
    language: ReplyLanguage;
    question: string | null;
    tally: GroupPollTally;
    card: boolean;
  },
): Promise<
  | { status: 'sent' }
  | { status: 'unsent'; notice: { skipped: GroupPlanRsvpVoiceSkip | 'not_sent' } }
> {
  const spoken = await composeGroupPlanRsvpLine(
    groupPollLineInput({
      kind: input.kind,
      language: input.language,
      question: input.question,
      tally: input.tally,
      card: input.card,
    }),
    deps.composer ?? productionGroupPlanRsvpComposer(),
  );
  if (spoken.status === 'skipped') {
    console.warn(
      { outcome: 'group_poll_line_unsent', kind: input.kind, reason: spoken.reason },
      'group poll: line not sent',
    );
    return { status: 'unsent', notice: { skipped: spoken.reason } };
  }
  try {
    await deps.send({ chatId: input.chatId, text: spoken.line, kind: 'poll' });
  } catch (err) {
    console.error({ err: err instanceof Error ? err.name : 'unknown' }, 'group poll: send failed');
    return { status: 'unsent', notice: { skipped: 'not_sent' } };
  }
  return { status: 'sent' };
}

function spokenOrUnsent(
  said: Awaited<ReturnType<typeof speakPoll>>,
  pollTally: GroupPollTally,
): GroupPollTurnResult {
  return said.status === 'sent'
    ? { handled: true, outcome: 'group_poll_spoken', count: 'intake', notice: 'sent', pollTally }
    : {
        handled: true,
        outcome: 'group_poll_line_unsent',
        count: 'ignored',
        notice: said.notice,
        pollTally,
      };
}

/** A poll intent the shared reader returned for one group message. */
export async function takeGroupPollReading(
  reading: GroupPlanRsvpReading,
  context: {
    chatId: string;
    language: ReplyLanguage;
    now: Date;
    livePoll: GroupPollRecord | null;
    seated: readonly ExpectedPerson[];
    voter: GroupPollVoter;
  },
  deps: GroupPollTurnDeps,
): Promise<GroupPollTurnResult | { handled: false }> {
  if (reading.intent === 'start_poll') return startPoll(reading, context, deps);

  const poll = context.livePoll;
  if (!poll) return { handled: false };

  if (reading.intent === 'ask_poll') {
    const tally = await deps.store.loadPollTally(poll.id);
    const said = await speakPoll(deps, {
      chatId: context.chatId,
      kind: 'poll_tally',
      language: context.language,
      question: poll.question,
      tally,
      card: false,
    });
    return spokenOrUnsent(said, tally);
  }

  const optionKey = reading.pollChoice ?? null;
  if (!optionKey || !poll.options.some((option) => option.key === optionKey)) {
    return { handled: true, outcome: 'group_poll_unread', count: 'ignored' };
  }
  return recordAndSettle(deps, {
    chatId: context.chatId,
    language: context.language,
    now: context.now,
    poll,
    voter: context.voter,
    optionKey,
    source: 'text',
  });
}

async function startPoll(
  reading: GroupPlanRsvpReading,
  context: {
    chatId: string;
    language: ReplyLanguage;
    now: Date;
    seated: readonly ExpectedPerson[];
  },
  deps: GroupPollTurnDeps,
): Promise<GroupPollTurnResult | { handled: false }> {
  const cover = await deps.store.coveringFamily(context.chatId);
  if (!cover) return { handled: false };
  const question = reading.pollQuestion?.trim() || null;
  const choices = choicesOf(reading);
  const expected = expectedOf(context.seated);

  if (choices.length < 2) {
    const tally = tallyGroupPoll([], [], expected);
    const said = await speakPoll(deps, {
      chatId: context.chatId,
      kind: 'poll_needs_options',
      language: context.language,
      question,
      tally,
      card: false,
    });
    return spokenOrUnsent(said, tally);
  }

  const options = choices.map((text, index) => ({
    key: optionKeyAt(index),
    text,
    providerOptionId: null,
  }));
  const opening = tallyGroupPoll(options, [], expected);
  const cardPlanned = deps.card?.enabled() ?? false;
  const said = await speakPoll(deps, {
    chatId: context.chatId,
    kind: 'poll_started',
    language: context.language,
    question,
    tally: opening,
    card: cardPlanned,
  });
  if (said.status !== 'sent') return spokenOrUnsent(said, opening);

  const poll = await deps.store.createPoll({
    chatId: context.chatId,
    familyId: cover.familyId,
    question,
    options: choices.map((text) => ({ text, providerOptionId: null })),
    expected,
    origin: 'parent',
    providerMessageId: null,
    now: context.now,
  });

  let card: GroupPollTurnResult['card'];
  if (!deps.card) {
    console.warn({ card: 'no_card_port' }, 'group poll: no native card port — text votes only');
    card = { skipped: 'no_card_port' };
  } else if (!cardPlanned) {
    card = { skipped: 'polls_off' };
  } else {
    const sent = await deps.card.send({
      chatId: context.chatId,
      familyId: cover.familyId,
      pollId: poll.id,
      options: poll.options.map((option) => ({ key: option.key, text: option.text })),
      now: context.now,
    });
    if (sent.status === 'sent') {
      await deps.store.attachCard(poll.id, {
        providerMessageId: sent.providerMessageId,
        options: sent.options,
      });
      card = 'sent';
    } else {
      console.warn({ card: sent.reason }, 'group poll: native card not sent — text votes only');
      card = { skipped: sent.reason };
    }
  }

  return {
    handled: true,
    outcome: 'group_poll_spoken',
    count: 'intake',
    notice: 'sent',
    card,
    pollTally: await deps.store.loadPollTally(poll.id),
  };
}

async function recordAndSettle(
  deps: GroupPollTurnDeps,
  input: {
    chatId: string;
    language: ReplyLanguage;
    now: Date;
    poll: GroupPollRecord;
    voter: GroupPollVoter;
    optionKey: string;
    source: 'text' | 'native';
  },
): Promise<GroupPollTurnResult> {
  const before = await deps.store.loadPollTally(input.poll.id);
  const { changed } = await deps.store.recordPollVote({
    pollId: input.poll.id,
    memberKey: input.voter.memberKey,
    displayName: input.voter.displayName,
    userId: input.voter.userId,
    haleCustomer: input.voter.haleCustomer,
    optionKey: input.optionKey,
    source: input.source,
    now: input.now,
  });
  const after = await deps.store.loadPollTally(input.poll.id);
  if (!changed || !isPollSettlePoint({ asked: false, before, after })) {
    return { handled: true, outcome: 'group_poll_recorded', count: 'ignored', pollTally: after };
  }
  const said = await speakPoll(deps, {
    chatId: input.chatId,
    kind: 'poll_tally',
    language: input.language,
    question: input.poll.question,
    tally: after,
    card: false,
  });
  return spokenOrUnsent(said, after);
}

export interface GroupPollCardVoteInput {
  chatId: string;
  event: 'added' | 'removed';
  /** Linq's option id from the vote webhook. */
  optionId: string;
  /** The poll card the option belongs to, from `linq_poll_options`. */
  card: {
    providerMessageId: string;
    familyId: string;
    pollKind: string | null;
    subjectKey: string | null;
  };
  voter: GroupPollVoter;
  language: ReplyLanguage;
  now: Date;
}

/** Resolve the live poll a native card vote belongs to, adopting a stuck-offer card once. */
async function pollForCardVote(
  store: GroupPlanRsvpStore,
  input: GroupPollCardVoteInput,
): Promise<GroupPollRecord | null> {
  if (input.card.pollKind === GROUP_POLL_KIND) {
    const live = await store.loadLivePoll(input.chatId);
    return live && live.id === input.card.subjectKey ? live : null;
  }
  const existing = await store.pollForCard(input.chatId, input.card.providerMessageId);
  if (existing) return existing;
  if (input.event === 'removed') return null;
  const cardOptions = await store.cardOptions(input.card.providerMessageId);
  if (cardOptions.length < 2) return null;
  const seated = await store.seatedExpected(input.chatId);
  return store.createPoll({
    chatId: input.chatId,
    familyId: input.card.familyId,
    question: null,
    options: cardOptions.map((option) => ({
      text: option.text,
      providerOptionId: option.optionId,
    })),
    expected: expectedOf(seated),
    origin: 'hale_offer',
    providerMessageId: input.card.providerMessageId,
    now: input.now,
  });
}

/**
 * A tap on a native group poll card. Protocol, not wording: Linq names the
 * option id and the voter. A removal clears the pick only while it is still
 * that option. Quiet unless the last person Hale was waiting on just picked.
 */
export async function takeGroupPollCardVote(
  input: GroupPollCardVoteInput,
  deps: GroupPollTurnDeps,
): Promise<GroupPollTurnResult | { handled: false }> {
  if (!isGroupPollCardKind(input.card.pollKind)) return { handled: false };
  const poll = await pollForCardVote(deps.store, input);
  if (!poll) {
    console.warn(
      { outcome: 'group_poll_card_unknown', pollKind: input.card.pollKind },
      'group poll: vote on a card with no live poll — not counted',
    );
    return { handled: true, outcome: 'group_poll_unread', count: 'ignored' };
  }
  const option = poll.options.find((candidate) => candidate.providerOptionId === input.optionId);
  if (!option) return { handled: true, outcome: 'group_poll_unread', count: 'ignored' };

  if (input.event === 'removed') {
    await deps.store.clearPollVote({
      pollId: poll.id,
      memberKey: input.voter.memberKey,
      optionKey: option.key,
      now: input.now,
    });
    return {
      handled: true,
      outcome: 'group_poll_recorded',
      count: 'ignored',
      pollTally: await deps.store.loadPollTally(poll.id),
    };
  }

  return recordAndSettle(deps, {
    chatId: input.chatId,
    language: input.language,
    now: input.now,
    poll,
    voter: input.voter,
    optionKey: option.key,
    source: 'native',
  });
}
