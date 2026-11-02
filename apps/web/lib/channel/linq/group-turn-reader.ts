import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { loadTranscript, resolveNoteConversation } from '~/lib/coach/conversation';
import { channelGroupNoteKey } from '~/lib/coach/note-key';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * VIL-440 (T27) — the model reads whether a group message is Hale's turn.
 *
 * The only group turn path: there is no name or keyword fallback. It runs when
 * `LINQ_GROUP_TURN_AI_ENABLED` is exactly `true` (default off; dark means silent in the
 * group). Code owns the routing;
 * the `group-turn-read` skill reads the words in any language. No echo of the text is
 * asked for, so a long message is never dropped for not fitting the output. A failed
 * read keeps Hale silent (one unasked reply in a family chat is worse than one missed
 * turn) and logs.
 */

/** Whether a group message is Hale's to answer. Opt-out (read by the model, #868) wins. */
export type GroupTurnDecision =
  | { route: 'keyword'; keyword: 'stop' | 'start' }
  | { route: 'coach'; reason: 'addressed' | 'question' }
  | { route: 'duty' }
  | { route: 'ignore'; outcome: 'group_chatter_ignored' };

export const GROUP_TURNS = ['addressed', 'question_for_hale', 'duty', 'chatter'] as const;
export type GroupTurnReading = (typeof GROUP_TURNS)[number];

export interface GroupTurnReadInput {
  text: string;
  senderName: string | null;
  haleNames: readonly string[];
  recent: readonly { from: 'hale' | 'member'; text: string }[];
}

export interface GroupTurnReader {
  /** Null: the read failed after its retry. */
  read(input: GroupTurnReadInput): Promise<GroupTurnReading | null>;
}

const outputSchema = z.object({ turn: z.enum(GROUP_TURNS) });
const outputJsonSchema = {
  type: 'object',
  properties: { turn: { type: 'string', enum: [...GROUP_TURNS] } },
  required: ['turn'],
} as const;

/** How many earlier group lines the read sees. Context, not a cap on the message. */
export const GROUP_TURN_RECENT_LINES = 6;

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function groupTurnUserMessage(input: GroupTurnReadInput): string {
  return JSON.stringify({
    text: input.text,
    senderName: input.senderName,
    haleNames: [...input.haleNames],
    recent: input.recent.slice(-GROUP_TURN_RECENT_LINES),
  });
}

export function linqGroupTurnAiEnabled(): boolean {
  return process.env.LINQ_GROUP_TURN_AI_ENABLED?.trim() === 'true';
}

/** Map a reading (or a failed read) to the door's route. Opt-out still wins first. */
export function groupTurnFromReading(
  reading: GroupTurnReading | null,
  optOut: 'stop' | 'start' | null,
): GroupTurnDecision {
  if (optOut) return { route: 'keyword', keyword: optOut };
  if (reading === 'addressed') return { route: 'coach', reason: 'addressed' };
  if (reading === 'question_for_hale') return { route: 'coach', reason: 'question' };
  if (reading === 'duty') return { route: 'duty' };
  return { route: 'ignore', outcome: 'group_chatter_ignored' };
}

export function createGroupTurnReader(
  clientOrResolver: AgentClient | (() => AgentClient),
): GroupTurnReader {
  const once = async (input: GroupTurnReadInput): Promise<GroupTurnReading | null> => {
    const client = typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
    const skill = await loadCronSkill('group-turn-read');
    const { value } = await forceToolJson({
      client,
      lane: pickLane(skill.meta.task),
      system: skill.instructions,
      userMessage: groupTurnUserMessage(input),
      toolName: 'group_turn',
      toolDescription: 'Return whether this group message is for Hale.',
      inputJsonSchema: outputJsonSchema,
      schema: outputSchema,
      maxTokens: 200,
    });
    return value.turn;
  };
  return {
    async read(input) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const reading = await once(input);
          if (reading) return reading;
        } catch (err) {
          console.warn(
            { attempt, err: err instanceof Error ? err.name : 'unknown' },
            'group turn reader: read failed',
          );
        }
      }
      console.error({ outcome: 'group_turn_unread' }, 'group turn reader: staying silent');
      return null;
    },
  };
}

let shared: GroupTurnReader | null = null;

export function sharedGroupTurnReader(): GroupTurnReader {
  shared ??= createGroupTurnReader(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

/**
 * The read's context, group-only (VIL-439 scope): the sender's first name and the last
 * lines of THIS group's thread. Never a parent's 1:1 thread.
 */
export async function groupTurnReadContext(
  database: Database,
  input: { familyId: string | null; chatId: string; senderUserId: string | null },
): Promise<Pick<GroupTurnReadInput, 'senderName' | 'recent'>> {
  let senderName: string | null = null;
  if (input.senderUserId) {
    const [row] = await database
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, input.senderUserId))
      .limit(1);
    senderName = row?.name?.trim().split(/\s+/)[0] || null;
  }
  if (!input.familyId) return { senderName, recent: [] };
  const conversationId = await resolveNoteConversation(
    input.familyId,
    channelGroupNoteKey(input.chatId),
    database,
  );
  if (!conversationId) return { senderName, recent: [] };
  const transcript = await loadTranscript(conversationId, database);
  return {
    senderName,
    recent: transcript.slice(-GROUP_TURN_RECENT_LINES).map((line) => ({
      from: line.role === 'assistant' ? ('hale' as const) : ('member' as const),
      text: line.content,
    })),
  };
}
