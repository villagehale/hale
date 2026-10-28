import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { forceToolJson } from '~/lib/pipeline/structured';
import { linqMultiFamilyGroupsEnabled, linqPollsEnabled } from './config';
import { type LinqPollOffer, sendChoicePoll } from './poll';

/**
 * VIL-458 slice 2 — offer a native poll when a multi-family group is stuck
 * choosing, behind LINQ_POLLS and LINQ_MULTI_FAMILY_GROUPS_ENABLED.
 *
 * The model (skill `group-poll-offer`) reads the thread and usually says no.
 * It writes any prompt and the options from facts already in the messages.
 * Code does no keyword matching and no fixed copy. It only:
 *   - applies the hard guards (flags, quiet hours, one ask this turn, an
 *     already-open poll, a recent offer in this chat),
 *   - hands the model the thread plus those two facts (no ids),
 *   - rejects a failed or unusable read (send nothing),
 *   - sends through {@link sendChoicePoll} when the model offers two or more
 *     options.
 *
 * Not wired into inbound. A failed model call is no send (no fallback).
 */

const QUIET_START = '21:00:00';
const QUIET_END = '08:00:00';
const DEFAULT_ZONE = 'America/Toronto';
export const RECENT_OFFER_MS = 24 * 60 * 60 * 1000;
export const OPEN_POLL_MS = 7 * 24 * 60 * 60 * 1000;
const OFFER_MAX = 400;

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
  prompt: string;
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
    prompt: { type: 'string' },
    options: { type: 'array', items: { type: 'string' } },
  },
  required: ['offer', 'prompt', 'options'],
} as const;

const offerSchema = z.object({
  offer: z.boolean(),
  prompt: z.string(),
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

/** Null when offer is true but the options are unusable. */
export function pollOfferFromAnswer(answer: PollOfferAnswer): GroupPollOfferDecision | null {
  if (!answer.offer) return { offer: false, prompt: '', options: [] };
  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of answer.options) {
    const text = raw.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    options.push(text);
  }
  if (options.length < 2) return null;
  return { offer: true, prompt: answer.prompt.trim(), options };
}

export type StuckPollOfferResult =
  | Extract<LinqPollOffer, { status: 'sent' } | { status: 'prompted' }>
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
        | 'model_unreachable';
    }
  | Extract<LinqPollOffer, { status: 'skipped' }>;

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
  if (reading.options.length < 2) return { status: 'skipped', reason: 'not_a_choice' };
  const day = input.now.toISOString().slice(0, 10);
  return sendChoicePoll(database, {
    chatId: input.chatId,
    prompt: reading.prompt || null,
    options: reading.options.map((text) => ({ text, pollKind: 'group_stuck' })),
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
    fetch: input.fetch,
    idempotencyKey: `poll:group-stuck:${input.chatId}:${day}`.slice(0, 180),
  });
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
        eq(schema.channelMessages.templateKey, 'linq:poll'),
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
      toolDescription: 'Say whether Hale should offer a poll, and if so write it from the thread.',
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
