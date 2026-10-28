import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { acceptedStatus } from '~/lib/channel/ledger';
import { loadCronSkill } from '~/lib/cron/skill';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { forceToolJson } from '~/lib/pipeline/structured';
import { linqMultiFamilyGroupsEnabled, linqPollsEnabled } from './config';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * VIL-458 slice 2 — when a multi-family group is stuck choosing, Hale may send
 * one AI-written text that names the options and invites a tapback or a quick
 * reply. Behind LINQ_POLLS and LINQ_MULTI_FAMILY_GROUPS_ENABLED. There is no
 * native poll card and no sendChoicePoll on this path.
 *
 * The model (skill `group-poll-offer`) reads the thread and usually says no.
 * It writes the one text and the option labels from facts already in the
 * messages. Code does no keyword matching and no fixed copy. It only:
 *   - applies the hard guards (flags, quiet hours, one ask this turn, an
 *     already-open poll, a recent offer in this chat),
 *   - hands the model the thread plus those two facts (no ids),
 *   - rejects a failed or unusable read (send nothing),
 *   - sends the model's text through {@link sendLinqChatMessage}.
 *
 * Not wired into inbound. A failed model call is no send (no fallback).
 *
 * SEAM (Noah, #935 / #938) — this file does not tally votes. Do not extend
 * `./group-poll-tally.ts` for tapbacks or quick replies after this text. The
 * single shared tally is consolidating on PR #938
 * (`./group-plan-rsvp` — `reading.ts` + `tally.ts`). Until inbound wires that
 * reader, {@link GROUP_OFFER_TALLY_SEAM} is the named handoff.
 */

const QUIET_START = '21:00:00';
const QUIET_END = '08:00:00';
const DEFAULT_ZONE = 'America/Toronto';
export const RECENT_OFFER_MS = 24 * 60 * 60 * 1000;
export const OPEN_POLL_MS = 7 * 24 * 60 * 60 * 1000;
export const GROUP_OFFER_TEMPLATE = 'linq:group_offer';
const OFFER_MAX = 400;
const RECENT_TEMPLATES = [GROUP_OFFER_TEMPLATE, 'linq:poll'] as const;

/**
 * Named handoff for votes after a stuck-group offer. Tapbacks and quick
 * replies in this chat are the answers. Read them through the shared tally
 * consolidating on PR #938 — do not add a second counter here, and do not
 * grow `group-poll-tally.ts` for this path. Merge #938 when inbound wires
 * the read (no rebase).
 */
export const GROUP_OFFER_TALLY_SEAM = {
  reader: 'pr-938-group-plan-rsvp',
  path: 'apps/web/lib/channel/linq/group-plan-rsvp',
} as const;

export interface GroupPollOfferMessage {
  from: string;
  text: string;
}

export interface GroupPollOfferInput {
  messages: readonly GroupPollOfferMessage[];
  openPoll: boolean;
  recentOffer: boolean;
}

export interface GroupPollOfferDecision {
  offer: boolean;
  text: string;
  options: string[];
}

export interface GroupPollOfferJudge {
  /** Null: the read failed after its retry. */
  decide(input: GroupPollOfferInput): Promise<GroupPollOfferDecision | null>;
}

export const POLL_OFFER_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    offer: { type: 'boolean' },
    text: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['offer', 'text', 'options'],
} as const;

const offerSchema = z.object({
  offer: z.boolean(),
  text: z.string(),
  options: z.array(z.string()),
});
export type PollOfferAnswer = z.infer<typeof offerSchema>;

/** The user-turn payload. Shared with the eval so it replays the same request. */
export function pollOfferUserMessage(input: GroupPollOfferInput): string {
  return JSON.stringify({
    openPoll: input.openPoll,
    recentOffer: input.recentOffer,
    messages: input.messages.map((m) => ({ from: m.from, text: m.text })),
  });
}

/** Null when offer is true but the text or options are unusable. */
export function pollOfferFromAnswer(answer: PollOfferAnswer): GroupPollOfferDecision | null {
  if (!answer.offer) return { offer: false, text: '', options: [] };
  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of answer.options) {
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    options.push(text);
  }
  const text = answer.text.trim();
  if (!text || options.length < 2) return null;
  return { offer: true, text, options };
}

export type StuckPollOfferResult =
  | { status: 'sent'; providerMessageId: string; channelMessageId: string }
  | { status: 'held'; reason: 'quiet_hours' }
  | {
      status: 'skipped';
      reason:
        | 'flag_off'
        | 'already_asked'
        | 'poll_open'
        | 'recent_offer'
        | 'judge_no'
        | 'not_a_choice'
        | 'model_unreachable'
        | 'refused'
        | 'not_configured';
      code?: string;
    };

export async function considerStuckGroupPoll(
  database: Database,
  judge: GroupPollOfferJudge,
  input: {
    chatId: string;
    familyId: string;
    parentUserId: string;
    messages: readonly GroupPollOfferMessage[];
    alreadyAskedThisTurn?: boolean;
    now: Date;
    fetch?: typeof fetch;
    timeZone?: string;
  },
): Promise<StuckPollOfferResult> {
  if (!linqPollsEnabled() || !linqMultiFamilyGroupsEnabled()) {
    return { status: 'skipped', reason: 'flag_off' };
  }
  if (input.alreadyAskedThisTurn) {
    console.warn(
      { familyId: input.familyId, skipped: 'already_asked' },
      'group poll offer: one ask this turn — not sent',
    );
    return { status: 'skipped', reason: 'already_asked' };
  }
  const timeZone = input.timeZone ?? (await householdZone(database, input.parentUserId));
  if (isWithinQuietHours(input.now, timeZone, QUIET_START, QUIET_END)) {
    console.warn(
      { familyId: input.familyId, skipped: 'quiet_hours' },
      'group poll offer: quiet hours — not sent',
    );
    return { status: 'held', reason: 'quiet_hours' };
  }
  const recent = await chatHasRecentOffer(database, input.chatId, input.now);
  if (recent) {
    console.warn(
      { familyId: input.familyId, skipped: 'recent_offer' },
      'group poll offer: recent offer in this chat — not sent',
    );
    return { status: 'skipped', reason: 'recent_offer' };
  }
  const openPoll = await chatHasOpenPoll(database, input.chatId, input.now);
  if (openPoll) {
    console.warn(
      { familyId: input.familyId, skipped: 'poll_open' },
      'group poll offer: a poll is already open — not sent',
    );
    return { status: 'skipped', reason: 'poll_open' };
  }
  const reading = await judge.decide({
    messages: input.messages,
    openPoll: false,
    recentOffer: false,
  });
  if (!reading) {
    console.error(
      { outcome: 'group_poll_offer_unread' },
      'group poll offer: no offer, sending nothing',
    );
    return { status: 'skipped', reason: 'model_unreachable' };
  }
  if (!reading.offer) return { status: 'skipped', reason: 'judge_no' };
  if (!reading.text || reading.options.length < 2) {
    return { status: 'skipped', reason: 'not_a_choice' };
  }
  return sendOfferText(database, {
    chatId: input.chatId,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
    fetch: input.fetch,
    text: reading.text,
    options: reading.options,
  });
}

async function sendOfferText(
  database: Database,
  args: {
    chatId: string;
    familyId: string;
    parentUserId: string;
    now: Date;
    fetch?: typeof fetch;
    text: string;
    options: readonly string[];
  },
): Promise<StuckPollOfferResult> {
  try {
    const sent = await sendLinqChatMessage({
      chatId: args.chatId,
      text: args.text,
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
        templateKey: GROUP_OFFER_TEMPLATE,
        providerMessageId: sent.providerMessageId,
        providerChatId: args.chatId,
        status: acceptedStatus('imessage'),
        sentAt: args.now,
      })
      .returning({ id: schema.channelMessages.id });
    const channelMessageId = row?.id;
    if (!channelMessageId) throw new Error('group offer: channel_messages insert returned no row');
    await database.insert(schema.auditLog).values({
      familyId: args.familyId,
      actor: args.parentUserId,
      actionTaken: 'linq_group_offer_sent',
      targetTable: 'channel_messages',
      targetId: channelMessageId,
      after: { options: [...args.options] },
    });
    return { status: 'sent', providerMessageId: sent.providerMessageId, channelMessageId };
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    console.warn(
      {
        familyId: args.familyId,
        code,
        httpStatus: err instanceof LinqSendError ? err.httpStatus : 0,
      },
      'group poll offer: not sent',
    );
    return {
      status: 'skipped',
      reason: code === 'not_configured' ? 'not_configured' : 'refused',
      code,
    };
  }
}

async function householdZone(database: Database, userId: string): Promise<string> {
  if (typeof database.select !== 'function') return DEFAULT_ZONE;
  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.timezone || DEFAULT_ZONE;
}

async function chatHasRecentOffer(database: Database, chatId: string, now: Date): Promise<boolean> {
  if (typeof database.select !== 'function') return false;
  const since = new Date(now.getTime() - RECENT_OFFER_MS);
  const rows = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.providerChatId, chatId),
        inArray(schema.channelMessages.templateKey, [...RECENT_TEMPLATES]),
        gte(schema.channelMessages.sentAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function chatHasOpenPoll(database: Database, chatId: string, now: Date): Promise<boolean> {
  if (typeof database.select !== 'function') return false;
  const since = new Date(now.getTime() - OPEN_POLL_MS);
  const rows = await database
    .select({ id: schema.linqPollOptions.id })
    .from(schema.linqPollOptions)
    .where(
      and(
        eq(schema.linqPollOptions.providerChatId, chatId),
        gte(schema.linqPollOptions.createdAt, since),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export function createGroupPollOfferJudge(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupPollOfferJudge {
  const once = async (input: GroupPollOfferInput) => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('group-poll-offer');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: pollOfferUserMessage(input),
      toolName: 'group_poll_offer',
      toolDescription:
        'Say whether Hale should send one text that names the options and invites a tapback or a quick reply.',
      inputJsonSchema: POLL_OFFER_TOOL_SCHEMA,
      schema: offerSchema,
      maxTokens: OFFER_MAX,
    });
    return pollOfferFromAnswer(value);
  };
  return {
    async decide(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group poll offer: read failed',
          );
        }
      }
      return null;
    },
  };
}
