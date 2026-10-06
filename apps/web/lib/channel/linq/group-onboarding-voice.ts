import { pickLane } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import { loadCronSkill } from '~/lib/cron/skill';
import { composeVoice, firstJsonObject, voiceClient } from '~/lib/loop/voice/compose';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import {
  type GroupOnboardingKind,
  type GroupOnboardingLine,
  type GroupOnboardingRequest,
  groupOnboardingLineInput,
} from './group-onboarding-line-input';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * Group onboarding v2 — say one who's-who line into the group.
 *
 * The model writes it (`composeVoice`, skill `group-onboarding-voice`); code owns the
 * facts and the ledger. Claim, send, stamp: the `channel_messages` row is the claim, so a
 * line goes out at most once per dedupe key, and `sms_reply_sent` is audited only after
 * it lands. A line the model could not write is retried once, then `group_line_unsent`:
 * nothing is sent, Slack #ops is paged, and the claim is not spent so the next inbound
 * tries again. A refused send releases its dedupe key.
 */

export type GroupLineSend = (input: {
  chatId: string;
  text: string;
  replyTo?: string;
}) => Promise<{ providerMessageId: string }>;

export type GroupLineSource = 'composed' | 'retry';

export type GroupLineFallback =
  | 'voice_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable';

export type GroupLineOutcome =
  | { outcome: 'sent'; source: GroupLineSource }
  | { outcome: 'already_sent' }
  | { outcome: 'not_sent'; code: string }
  | { outcome: 'group_line_unsent'; fallback: GroupLineFallback };

/** Test seam. Production leaves this unset and uses {@link composeVoice}. */
export interface GroupOnboardingComposer {
  compose(
    input: GroupOnboardingLine,
    options?: { prompt?: 'full' | 'short' },
  ): Promise<{ line: string }>;
}

interface SpokenGroupLine {
  body: string;
  source: GroupLineSource | 'unsent';
  fallback: GroupLineFallback | null;
}

function factStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(factStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(factStrings);
  return [];
}

function parseSpokenLine(answer: string | null, questions: 0 | 1): { line: string } | null {
  if (!answer) return null;
  const raw = firstJsonObject(answer);
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (questions === 0 && typeof record.line === 'string' && record.line.trim()) {
    return { line: record.line.trim() };
  }
  if (questions === 1 && typeof record.question === 'string' && record.question.trim()) {
    const before = typeof record.before === 'string' ? record.before.trim() : '';
    return { line: [before, record.question.trim()].filter(Boolean).join(' ') };
  }
  return null;
}

function lineUsable(line: string, input: GroupOnboardingLine): boolean {
  if (input.questions === 1 && !line.includes('?')) return false;
  if (input.questions === 0 && line.includes('?')) return false;
  if (/https?:\/\//i.test(line)) return false;
  return input.mustMention.every((slot) => line.includes(slot));
}

async function pageUnsent(kind: GroupOnboardingKind, fallback: GroupLineFallback): Promise<void> {
  const outcome = await postOpsSlack(
    `Hale group onboarding: a ${kind} line was not sent (${fallback}). Nothing went to the parent.`,
  );
  console.warn({ kind, fallback, page: outcome }, 'linq group onboarding: line not sent');
}

function productionComposer(
  scope: { familyId: string; database: Database } | undefined,
): GroupOnboardingComposer | undefined {
  if (!process.env.ANTHROPIC_API_KEY || process.env.VOICE_DISABLED === 'true') return undefined;
  return {
    async compose(input, options) {
      const skill = await loadCronSkill('group-onboarding-voice');
      const client = voiceClient() ?? budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
      if (scope) {
        const composed = await composeVoice({
          skill,
          context: { ...input, retry: options?.prompt === 'short' },
          factSlots: [...input.mustMention, ...factStrings(input.facts)],
          parse: (answer) => parseSpokenLine(answer, input.questions),
          voiceStrings: (voice) => [voice.line],
          client,
          database: scope.database,
          familyId: scope.familyId,
          agentName: 'reply-copy',
          traceName: 'reply-copy',
          maxTokens: options?.prompt === 'short' ? 160 : 400,
        });
        if (!composed.voice) throw new Error(composed.reason ?? 'unusable');
        return composed.voice;
      }
      const lane = pickLane(skill.meta.task);
      const userMessage = JSON.stringify({ ...input, retry: options?.prompt === 'short' });
      const maxTokens = options?.prompt === 'short' ? 160 : 400;
      if (input.questions === 1) {
        const result = await forceToolJson({
          client,
          lane,
          system: skill.instructions,
          userMessage,
          toolName: 'send_group_line',
          toolDescription: 'The one message Hale sends.',
          inputJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: { before: { type: 'string' }, question: { type: 'string' } },
            required: ['before', 'question'],
          },
          schema: z.object({ before: z.string(), question: z.string() }),
          maxTokens,
        });
        return { line: [result.value.before, result.value.question].filter(Boolean).join(' ') };
      }
      const result = await forceToolJson({
        client,
        lane,
        system: skill.instructions,
        userMessage,
        toolName: 'send_group_line',
        toolDescription: 'The one message Hale sends.',
        inputJsonSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { line: { type: 'string' } },
          required: ['line'],
        },
        schema: z.object({ line: z.string() }),
        maxTokens,
      });
      return { line: result.value.line };
    },
  };
}

async function speak(
  voice: GroupOnboardingComposer | undefined,
  request: GroupOnboardingRequest,
  language: ReplyLanguage,
  parentWords: string | null,
  scope: { familyId: string; database: Database } | undefined,
): Promise<SpokenGroupLine> {
  const input = groupOnboardingLineInput(request, language, { parentWords });
  const composer = voice ?? productionComposer(scope);
  if (!composer) {
    await pageUnsent(request.kind, 'voice_unavailable');
    return { body: '', source: 'unsent', fallback: 'voice_unavailable' };
  }
  let last: GroupLineFallback = 'model_failed';
  for (const prompt of ['full', 'short'] as const) {
    try {
      const composed = await composer.compose(input, { prompt });
      if (lineUsable(composed.line, input)) {
        return {
          body: composed.line,
          source: prompt === 'full' ? 'composed' : 'retry',
          fallback: null,
        };
      }
      last = 'unusable';
    } catch {
      last = 'model_failed';
    }
  }
  await pageUnsent(request.kind, last);
  return { body: '', source: 'unsent', fallback: last };
}

async function deliver(
  send: GroupLineSend | undefined,
  input: { chatId: string; text: string; replyTo?: string },
): Promise<{ providerMessageId: string }> {
  if (send) return send(input);
  return sendLinqChatMessage({
    chatId: input.chatId,
    text: input.text,
    replyTo: input.replyTo ? { messageId: input.replyTo } : undefined,
  });
}

export async function sendGroupOnboardingLine(
  database: Database,
  input: {
    familyId: string;
    /** Whose ledger row this is: the household's primary parent. */
    ledgerUserId: string;
    chatId: string;
    request: GroupOnboardingRequest;
    language: ReplyLanguage;
    parentWords?: string | null;
    replyTo?: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
    voice: GroupOnboardingComposer | undefined;
    send?: GroupLineSend;
  },
): Promise<GroupLineOutcome> {
  const [prior] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.dedupeKey, input.dedupeKey));
  if (prior) return { outcome: 'already_sent' };

  const kind = input.request.kind;
  const spoken = await speak(
    input.voice,
    input.request,
    input.language,
    input.parentWords ?? null,
    {
      familyId: input.familyId,
      database,
    },
  );
  if (spoken.source === 'unsent') {
    const fallback = spoken.fallback ?? 'unusable';
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'group_line_unsent',
      targetTable: 'channel_messages',
      targetId: input.familyId,
      after: { kind, fallback, templateKey: input.templateKey },
    });
    console.warn({ kind, fallback }, 'linq group onboarding: line not sent');
    return { outcome: 'group_line_unsent', fallback };
  }
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
      text: spoken.body,
      replyTo: input.replyTo,
    });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.ledgerUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { templateKey: input.templateKey, source: spoken.source },
    });
    return { outcome: 'sent', source: spoken.source };
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code, dedupeKey: null })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.warn(
      { familyId: input.familyId, kind, code },
      'linq group onboarding: the line did not land',
    );
    return { outcome: 'not_sent', code };
  }
}

/**
 * A line into a chat that belongs to no family yet (`no_family_yet`). There is no family
 * row for a `channel_messages` or `audit_log` row to hang on, so this is the one
 * unledgered send in the flow: the caller claims it on the roster row, and every outcome
 * is logged and returned by name.
 */
export async function sendUnledgeredGroupLine(input: {
  chatId: string;
  request: GroupOnboardingRequest;
  language: ReplyLanguage;
  voice: GroupOnboardingComposer | undefined;
  send?: GroupLineSend;
}): Promise<GroupLineOutcome> {
  const spoken = await speak(input.voice, input.request, input.language, null, undefined);
  if (spoken.source === 'unsent') {
    const fallback = spoken.fallback ?? 'unusable';
    console.warn({ kind: input.request.kind, fallback }, 'linq group onboarding: line not sent');
    return { outcome: 'group_line_unsent', fallback };
  }
  try {
    await deliver(input.send, { chatId: input.chatId, text: spoken.body });
    console.info(
      { kind: input.request.kind, outcome: 'sent', ledger: 'no_family_row' },
      'linq group onboarding: unledgered line sent',
    );
    return { outcome: 'sent', source: spoken.source };
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    console.warn(
      { kind: input.request.kind, code },
      'linq group onboarding: the line did not land',
    );
    return { outcome: 'not_sent', code };
  }
}
