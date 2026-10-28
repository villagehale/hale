import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { acceptedStatus } from '~/lib/channel/ledger';
import { loadCronSkill } from '~/lib/cron/skill';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { GroupRsvpLineInput } from './group-rsvp-line-input';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * VIL-102 — one AI-written RSVP line into the group.
 *
 * The model writes it. Code owns the facts, the ledger, and the send. Two
 * attempts, then `group_line_unsent`: nothing is posted, #ops is paged, and
 * the claim is not spent. There is no fallback sentence.
 */

export type GroupRsvpLineSend = (input: {
  chatId: string;
  text: string;
  replyTo?: string;
}) => Promise<{ providerMessageId: string }>;

export interface GroupRsvpComposer {
  compose(input: GroupRsvpLineInput): Promise<{ send: boolean; line: string }>;
}

export type GroupRsvpLineOutcome =
  | { outcome: 'sent'; body: string }
  | { outcome: 'already_sent' }
  | { outcome: 'quiet' }
  | { outcome: 'not_sent'; code: string }
  | { outcome: 'group_line_unsent'; fallback: 'voice_unavailable' | 'model_failed' | 'unusable' };

const outputSchema = z.object({
  send: z.boolean(),
  line: z.string(),
  question: z.boolean(),
  why: z.string(),
});

const outputJsonSchema = {
  type: 'object',
  properties: {
    send: { type: 'boolean' },
    line: { type: 'string' },
    question: { type: 'boolean' },
    why: { type: 'string' },
  },
  required: ['send', 'line', 'question', 'why'],
} as const;

const LINE_MAX = 320;

function factStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(factStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(factStrings);
  return [];
}

export function rsvpLineUsable(line: string, input: GroupRsvpLineInput): boolean {
  const text = line.trim();
  if (!text) return false;
  if (text.length > LINE_MAX) return false;
  if (/https?:\/\//i.test(text) || /\+\d[\d\s-]{7,}/.test(text)) return false;
  const questions = (text.match(/\?/g) ?? []).length;
  if (input.questions === 0 && questions > 0) return false;
  if (input.questions === 1 && questions !== 1) return false;
  if (questions > 1) return false;
  if (/everyone'?s calendar/i.test(text) && !input.facts.inviteSent) return false;
  const allowed = new Set(factStrings(input.facts));
  for (const match of text.match(/\b\d+\b/g) ?? []) {
    if (!allowed.has(match)) return false;
  }
  return true;
}

export function createGroupRsvpComposer(): GroupRsvpComposer | null {
  if (!process.env.ANTHROPIC_API_KEY || process.env.VOICE_DISABLED === 'true') return null;
  return {
    async compose(input) {
      const skill = await loadCronSkill('group-rsvp-voice');
      const client = budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
      const { value } = await forceToolJson({
        client,
        lane: pickLane(skill.meta.task),
        system: skill.instructions,
        userMessage: JSON.stringify({
          kind: input.kind,
          language: input.language,
          parentWords: input.parentWords,
          facts: input.facts,
          questions: input.questions,
        }),
        toolName: 'send_group_rsvp_line',
        toolDescription: 'Return the one RSVP line Hale should post, or send false.',
        inputJsonSchema: outputJsonSchema,
        schema: outputSchema,
        maxTokens: 300,
      });
      return { send: value.send && input.facts.send, line: value.line.trim() };
    },
  };
}

let shared: GroupRsvpComposer | null | undefined;

export function sharedGroupRsvpComposer(): GroupRsvpComposer | null {
  if (shared === undefined) shared = createGroupRsvpComposer();
  return shared;
}

async function speak(
  voice: GroupRsvpComposer | undefined,
  input: GroupRsvpLineInput,
): Promise<
  { send: boolean; line: string } | { fallback: 'voice_unavailable' | 'model_failed' | 'unusable' }
> {
  const composer = voice ?? sharedGroupRsvpComposer();
  if (!composer) return { fallback: 'voice_unavailable' };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const spoken = await composer.compose(input);
      if (!spoken.send || !input.facts.send) return { send: false, line: '' };
      if (rsvpLineUsable(spoken.line, input)) return spoken;
    } catch (err) {
      console.warn(
        { attempt, err: err instanceof Error ? err.name : 'unknown' },
        'group rsvp voice: compose failed',
      );
    }
  }
  return { fallback: 'unusable' };
}

async function deliver(
  send: GroupRsvpLineSend | undefined,
  input: { chatId: string; text: string; replyTo?: string },
): Promise<{ providerMessageId: string }> {
  if (send) return send(input);
  return sendLinqChatMessage({
    chatId: input.chatId,
    text: input.text,
    replyTo: input.replyTo ? { messageId: input.replyTo } : undefined,
  });
}

export async function sendGroupRsvpLine(
  database: Database,
  input: {
    familyId: string;
    ledgerUserId: string;
    chatId: string;
    line: GroupRsvpLineInput;
    replyTo?: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
    voice?: GroupRsvpComposer;
    send?: GroupRsvpLineSend;
  },
): Promise<GroupRsvpLineOutcome> {
  const [prior] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.dedupeKey, input.dedupeKey));
  if (prior) return { outcome: 'already_sent' };

  const spoken = await speak(input.voice, input.line);
  if ('fallback' in spoken) {
    const fallback = spoken.fallback ?? 'unusable';
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'group_line_unsent',
      targetTable: 'channel_messages',
      targetId: input.familyId,
      after: { kind: input.line.kind, fallback, templateKey: input.templateKey },
    });
    const page = await postOpsSlack(
      `Hale group RSVP: a ${input.line.kind} line was not sent (${fallback}). Nothing went to the parent.`,
    );
    console.warn({ kind: input.line.kind, fallback, page }, 'linq group rsvp: line not sent');
    return { outcome: 'group_line_unsent', fallback };
  }
  if (!spoken.send || !spoken.line) return { outcome: 'quiet' };

  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.ledgerUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { outcome: 'already_sent' };

  try {
    const sent = await deliver(input.send, {
      chatId: input.chatId,
      text: spoken.line,
      replyTo: input.replyTo,
    });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId, body: spoken.line })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.ledgerUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { templateKey: input.templateKey, kind: input.line.kind },
    });
    return { outcome: 'sent', body: spoken.line };
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code, dedupeKey: null })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.warn({ familyId: input.familyId, code }, 'linq group rsvp: the line did not land');
    return { outcome: 'not_sent', code };
  }
}
