import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { linqPollsEnabled } from './config';
import { LinqSendError, sendLinqChatMessage, sendLinqPoll } from './transport';

/**
 * VIL-335 — the year-find poll, behind LINQ_POLLS=on.
 *
 * Design locked (Sloane). One ask, only after a year-find with two or more
 * hits, in the Linq thread that find already used. Never an empty find, never
 * unprompted, never on a conflict, a handoff, or a receipt. Titles are the
 * find's own titles. This module does not search and does not invent one.
 *
 * LINQ_POLLS stays off in this change. Ops turns it on after the PR ships.
 */

/** Design locked. The text that precedes the poll. A Linq poll has no question field. */
export const YEAR_FIND_POLL_PROMPT: Record<ReplyLanguage, string> = {
  en: 'Which of these should I look at first?',
  fr: 'Lequel je regarde en premier?',
};

/** Design locked. Always the last option. A vote for it is not another ask. */
export const YEAR_FIND_POLL_NONE: Record<ReplyLanguage, string> = {
  en: 'None of these',
  fr: 'Aucun de ceux-la',
};

/**
 * Design locked sandbox scenario. A demo send when there is no live find.
 * Not a fallback for an empty search, and not sent on its own.
 */
export const SANDBOX_YEAR_FIND_TITLES: Record<ReplyLanguage, readonly [string, string]> = {
  en: ['Swim at the rec centre', 'Library storytime'],
  fr: ['Nage au centre recreatif', 'Heure du conte a la bibliotheque'],
};

const NONE_OPTIONS = new Set<string>([YEAR_FIND_POLL_NONE.en, YEAR_FIND_POLL_NONE.fr]);

/** Exact match on the locked "none" option, either language. */
export function isYearFindPollNone(text: string): boolean {
  return NONE_OPTIONS.has(text.trim());
}

/**
 * Up to three find titles, then the locked none option. Fewer than two
 * titles is no poll. A title that is itself the none line is dropped.
 */
export function yearFindPollOptions(
  language: ReplyLanguage,
  titles: readonly string[],
): readonly string[] | null {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of titles) {
    const title = raw.trim();
    if (!title || seen.has(title) || NONE_OPTIONS.has(title)) continue;
    seen.add(title);
    cleaned.push(title);
    if (cleaned.length === 3) break;
  }
  if (cleaned.length < 2) return null;
  return [...cleaned, YEAR_FIND_POLL_NONE[language]];
}

/** The sandbox options, verbatim. Two fixed titles plus the none line. */
export function sandboxYearFindPollOptions(language: ReplyLanguage): readonly string[] {
  return [...SANDBOX_YEAR_FIND_TITLES[language], YEAR_FIND_POLL_NONE[language]];
}

export type LinqPollOffer =
  | { status: 'sent'; providerMessageId: string; channelMessageId: string }
  | { status: 'prompted' }
  | { status: 'skipped'; reason: 'flag_off' | 'not_a_choice' | 'not_imessage' | 'no_chat' }
  | { status: 'skipped'; reason: 'refused' | 'not_configured'; code: string };

/**
 * The live year-find ask. `titles` are the find's titles (pick name or civic
 * title), already sliced with the lines the parent just read. Same chat.
 */
export async function offerYearFindPoll(
  database: Database,
  args: {
    channel: string;
    chatId: string | null;
    titles: readonly string[];
    language: ReplyLanguage;
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<LinqPollOffer> {
  const options = yearFindPollOptions(args.language, args.titles);
  return offerPoll(database, {
    ...args,
    options,
    idempotencyKey: `poll:year-find:${args.familyId}:${args.now.toISOString().slice(0, 10)}`,
  });
}

/**
 * The sandbox scenario. Callers that want the demo pass this explicitly.
 * An empty year-find does not.
 */
export async function offerSandboxYearFindPoll(
  database: Database,
  args: {
    channel: string;
    chatId: string | null;
    language: ReplyLanguage;
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<LinqPollOffer> {
  return offerPoll(database, {
    ...args,
    options: sandboxYearFindPollOptions(args.language),
    idempotencyKey: `poll:year-find-sandbox:${args.familyId}:${args.now.toISOString().slice(0, 10)}`,
  });
}

async function offerPoll(
  database: Database,
  args: {
    channel: string;
    chatId: string | null;
    options: readonly string[] | null;
    language: ReplyLanguage;
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
    idempotencyKey: string;
  },
): Promise<LinqPollOffer> {
  if (!linqPollsEnabled()) return { status: 'skipped', reason: 'flag_off' };
  if (args.channel !== 'imessage') return { status: 'skipped', reason: 'not_imessage' };
  if (!args.chatId) return { status: 'skipped', reason: 'no_chat' };
  if (!args.options) return { status: 'skipped', reason: 'not_a_choice' };
  return deliverChoicePoll(database, {
    chatId: args.chatId,
    prompt: YEAR_FIND_POLL_PROMPT[args.language],
    options: args.options,
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    now: args.now,
    fetch: args.fetch,
    idempotencyKey: args.idempotencyKey,
  });
}

async function deliverChoicePoll(
  database: Database,
  args: {
    chatId: string;
    prompt: string;
    options: readonly string[];
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
    idempotencyKey: string;
  },
): Promise<LinqPollOffer> {
  let prompted = false;
  try {
    await sendLinqChatMessage({
      chatId: args.chatId,
      text: args.prompt,
      fetch: args.fetch,
    });
    prompted = true;
    const poll = await sendLinqPoll({
      chatId: args.chatId,
      options: args.options,
      idempotencyKey: args.idempotencyKey,
      fetch: args.fetch,
    });
    const [row] = await database
      .insert(schema.channelMessages)
      .values({
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        channel: 'imessage',
        direction: 'out',
        category: 'reply',
        templateKey: 'linq:poll',
        providerMessageId: poll.messageId,
        providerChatId: args.chatId,
        status: acceptedStatus('imessage'),
        sentAt: args.now,
      })
      .returning({ id: schema.channelMessages.id });
    const channelMessageId = row?.id;
    if (!channelMessageId) throw new Error('linq poll: channel_messages insert returned no row');
    await database.insert(schema.linqPollOptions).values(
      poll.options.map((option) => ({
        familyId: args.familyId,
        parentUserId: args.parentUserId,
        providerChatId: args.chatId as string,
        providerMessageId: poll.messageId,
        optionId: option.optionId,
        optionText: option.text,
      })),
    );
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_poll_sent',
      targetTable: 'channel_messages',
      targetId: channelMessageId,
    });
    return { status: 'sent', providerMessageId: poll.messageId, channelMessageId };
  } catch (err) {
    if (prompted) {
      console.warn(
        { familyId: args.familyId, code: err instanceof LinqSendError ? err.code : 'unknown' },
        'linq poll: question landed, poll did not — no second ask this turn',
      );
      return { status: 'prompted' };
    }
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    console.warn(
      {
        familyId: args.familyId,
        code,
        httpStatus: err instanceof LinqSendError ? err.httpStatus : 0,
      },
      'linq poll: not sent',
    );
    return {
      status: 'skipped',
      reason: code === 'not_configured' ? 'not_configured' : 'refused',
      code,
    };
  }
}

export async function lookupLinqPollOption(
  database: Database,
  optionId: string,
): Promise<{ familyId: string; parentUserId: string; chatId: string; text: string } | null> {
  const rows = await database
    .select({
      familyId: schema.linqPollOptions.familyId,
      parentUserId: schema.linqPollOptions.parentUserId,
      providerChatId: schema.linqPollOptions.providerChatId,
      optionText: schema.linqPollOptions.optionText,
      optionId: schema.linqPollOptions.optionId,
    })
    .from(schema.linqPollOptions)
    .where(eq(schema.linqPollOptions.optionId, optionId));
  const row = rows.find((candidate) => candidate.optionId === optionId);
  if (!row) return null;
  return {
    familyId: row.familyId,
    parentUserId: row.parentUserId,
    chatId: row.providerChatId,
    text: row.optionText,
  };
}
