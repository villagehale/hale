import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { linqPollsEnabled } from './config';
import { LinqSendError, sendLinqChatMessage, sendLinqPoll } from './transport';

/**
 * VIL-335 — a poll for a binary choice, behind LINQ_POLLS=on.
 *
 * Design has not locked a poll prompt. The question below is a placeholder for
 * Sloane. It is sent as its own text because a Linq poll has no question
 * field. Locked ask strings are not rewritten: a template key means this
 * caller refuses, and the flag defaults off.
 *
 * The kids-year scenario is the both-free reply. That sentence stays
 * locked. When the flag is on, {@link offerKidsYearChoicePoll} adds this
 * placeholder and a poll whose options are the two slot phrases. When the
 * flag is off, the locked sentence is the whole reply.
 */

/** DESIGN LOCK PENDING (Sloane). The text that precedes a poll. */
export const LINQ_POLL_PLACEHOLDER_PROMPT = 'Which of these should I look at first?';

const UNSAFE = /\b(911|stop|arret|arrêt)\b/i;

/**
 * Two short options in a coach sentence that is not a locked template.
 * "Soccer or swim?" qualifies. A Connect card, a co-parent ask, and anything
 * with a URL or an emergency number does not.
 */
export function binaryChoiceFromReply(
  body: string,
  templateKey: string | null,
): readonly [string, string] | null {
  if (templateKey) return null;
  const trimmed = body.trim();
  if (trimmed.length > 160 || trimmed.includes('http') || !trimmed.endsWith('?')) return null;
  if (UNSAFE.test(trimmed)) return null;
  const match = /^(.{2,40}) or (.{2,40})\?$/.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  const left = match[1].trim();
  const right = match[2].trim();
  if (!left || !right || left.includes('?') || right.includes('?')) return null;
  return [left, right];
}

export type LinqPollOffer =
  | { status: 'sent'; providerMessageId: string; channelMessageId: string }
  | { status: 'skipped'; reason: 'flag_off' | 'not_a_choice' | 'not_imessage' | 'no_chat' }
  | { status: 'skipped'; reason: 'refused' | 'not_configured'; code: string };

export async function offerLinqChoicePoll(
  database: Database,
  args: {
    channel: string;
    chatId: string | null;
    body: string;
    templateKey: string | null;
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<LinqPollOffer> {
  if (!linqPollsEnabled()) return { status: 'skipped', reason: 'flag_off' };
  if (args.channel !== 'imessage') return { status: 'skipped', reason: 'not_imessage' };
  if (!args.chatId) return { status: 'skipped', reason: 'no_chat' };
  const choice = binaryChoiceFromReply(args.body, args.templateKey);
  if (!choice) return { status: 'skipped', reason: 'not_a_choice' };
  return deliverChoicePoll(database, {
    chatId: args.chatId,
    options: choice,
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    now: args.now,
    fetch: args.fetch,
    idempotencyKey: `poll:${args.familyId}:${args.now.getTime()}`,
  });
}

/**
 * A both-free (or other kids-year) choice whose sentence is already locked.
 * The options are the slot phrases, not new voice. The placeholder question
 * is {@link LINQ_POLL_PLACEHOLDER_PROMPT}. Flag off sends nothing here.
 */
export async function offerKidsYearChoicePoll(
  database: Database,
  args: {
    channel: string;
    chatId: string | null;
    options: readonly [string, string];
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
  },
): Promise<LinqPollOffer> {
  if (!linqPollsEnabled()) return { status: 'skipped', reason: 'flag_off' };
  if (args.channel !== 'imessage') return { status: 'skipped', reason: 'not_imessage' };
  if (!args.chatId) return { status: 'skipped', reason: 'no_chat' };
  const left = args.options[0].trim();
  const right = args.options[1].trim();
  if (
    !left ||
    !right ||
    left.includes('http') ||
    right.includes('http') ||
    UNSAFE.test(left) ||
    UNSAFE.test(right)
  ) {
    return { status: 'skipped', reason: 'not_a_choice' };
  }
  const day = args.now.toISOString().slice(0, 10);
  return deliverChoicePoll(database, {
    chatId: args.chatId,
    options: [left, right],
    familyId: args.familyId,
    parentUserId: args.parentUserId,
    now: args.now,
    fetch: args.fetch,
    idempotencyKey: `poll:both-free:${args.familyId}:${day}`,
  });
}

async function deliverChoicePoll(
  database: Database,
  args: {
    chatId: string;
    options: readonly [string, string];
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
    idempotencyKey: string;
  },
): Promise<LinqPollOffer> {
  try {
    await sendLinqChatMessage({
      chatId: args.chatId,
      text: LINQ_POLL_PLACEHOLDER_PROMPT,
      fetch: args.fetch,
    });
    const poll = await sendLinqPoll({
      chatId: args.chatId,
      options: [args.options[0], args.options[1]],
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
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    console.warn(
      {
        familyId: args.familyId,
        code,
        httpStatus: err instanceof LinqSendError ? err.httpStatus : 0,
      },
      'linq poll: not sent — the text choice still goes out',
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
