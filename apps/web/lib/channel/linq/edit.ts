import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { acceptedStatus } from '~/lib/channel/ledger';
import { editLinqMessage } from '~/lib/channel/outbound-transport';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { LinqMessageEdit } from './payload';
import { LinqSendError } from './transport';

/**
 * VIL-479 — edit one text part of a bubble Hale already sent, when the model
 * says the follow-up is a correction of that bubble.
 *
 * Behind `LINQ_MESSAGE_EDIT_ENABLED`, exactly `true` (default off). The
 * `linq-edit` skill reads the follow-up Hale has written and the bubbles that
 * can still be edited, and returns the replacement text or null. Code never
 * writes the replacement: a failed or unusable read sends the follow-up as its
 * own message, which is what would have happened without this feature.
 *
 * Linq allows five edits within 15 minutes of the original send, text parts
 * only, iMessage only. A refusal falls through to the follow-up.
 */

export const LINQ_EDIT_WINDOW_MS = 15 * 60 * 1000;
export const LINQ_EDIT_MAX = 5;
const TEXT_MAX = 10_000;

export function linqMessageEditEnabled(): boolean {
  return process.env.LINQ_MESSAGE_EDIT_ENABLED?.trim() === 'true';
}

/** A bubble the model may replace. `channelMessageId` stays off the model payload. */
export interface EditableLinqSend {
  messageId: string;
  partIndex: number;
  text: string;
  sentAt: string;
  editsUsed: number;
  channelMessageId: string;
}

export interface LinqEditInput {
  audience: 'direct' | 'group';
  parentText: string;
  followUp: string;
  editable: readonly Pick<
    EditableLinqSend,
    'messageId' | 'partIndex' | 'text' | 'sentAt' | 'editsUsed'
  >[];
}

export interface LinqEditChoice {
  messageId: string;
  partIndex: number;
  text: string;
}

export interface LinqEditDecision {
  edit: LinqEditChoice | null;
}

export interface LinqEditDecider {
  /** Null: the read failed or came back unusable. The follow-up is sent. */
  decide(input: LinqEditInput): Promise<LinqEditDecision | null>;
}

export const LINQ_EDIT_TOOL = 'linq_edit';
export const LINQ_EDIT_MAX_TOKENS = 800;
export const LINQ_EDIT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    edit: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            messageId: { type: 'string' },
            partIndex: { type: 'integer' },
            text: { type: 'string' },
          },
          required: ['messageId', 'partIndex', 'text'],
        },
      ],
    },
  },
  required: ['edit'],
} as const;

const outputSchema = z.object({
  edit: z
    .object({
      messageId: z.string(),
      partIndex: z.number().int(),
      text: z.string(),
    })
    .nullable(),
});

/** The user-turn payload. The replacement text is not invented here. */
export function linqEditUserMessage(input: LinqEditInput): string {
  return JSON.stringify({
    audience: input.audience,
    parent: input.parentText,
    followUp: input.followUp,
    editable: input.editable.map((row) => ({
      messageId: row.messageId,
      partIndex: row.partIndex,
      text: row.text,
      sentAt: row.sentAt,
      editsUsed: row.editsUsed,
    })),
  });
}

/** Why a reading cannot be acted on. Wording is the model's; these are the send's limits. */
export type LinqEditRefusal =
  | 'unknown_message'
  | 'wrong_part'
  | 'empty_text'
  | 'too_long'
  | 'unchanged';

export function linqEditRefusals(
  decision: LinqEditDecision,
  editable: readonly Pick<EditableLinqSend, 'messageId' | 'partIndex' | 'text'>[],
): LinqEditRefusal[] {
  if (decision.edit === null) return [];
  const candidate = editable.find((row) => row.messageId === decision.edit?.messageId);
  const refusals: LinqEditRefusal[] = [];
  if (!candidate) {
    refusals.push('unknown_message');
    return refusals;
  }
  if (decision.edit.partIndex !== candidate.partIndex) refusals.push('wrong_part');
  if (decision.edit.text.length === 0) refusals.push('empty_text');
  if (decision.edit.text.length > TEXT_MAX) refusals.push('too_long');
  if (decision.edit.text === candidate.text) refusals.push('unchanged');
  return refusals;
}

type ClientSource = AgentClient | (() => AgentClient | Promise<AgentClient>);

export function createLinqEditDecider(clientOrResolver: ClientSource): LinqEditDecider {
  return {
    async decide(input) {
      try {
        const resolved =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
        const client = await resolved;
        const skill = await loadCronSkill('linq-edit');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: linqEditUserMessage(input),
          toolName: LINQ_EDIT_TOOL,
          toolDescription:
            'Return the bubble to replace, with the full new text of that part, or null to send the follow-up.',
          inputJsonSchema: LINQ_EDIT_TOOL_SCHEMA,
          schema: outputSchema,
          maxTokens: LINQ_EDIT_MAX_TOKENS,
        });
        const refusals = linqEditRefusals(value, input.editable);
        if (refusals.length > 0) {
          console.warn({ refusals }, 'linq edit: reading unusable, the follow-up still goes out');
          return null;
        }
        return value;
      } catch (err) {
        console.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'linq edit: read failed, the follow-up still goes out',
        );
        return null;
      }
    },
  };
}

let shared: LinqEditDecider | null = null;

export function sharedLinqEditDecider(): LinqEditDecider {
  shared ??= createLinqEditDecider(async () => {
    const { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } = await import('~/lib/pipeline/client');
    return budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS);
  });
  return shared;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

async function editsUsed(database: Database, channelMessageId: string): Promise<number> {
  const rows = await database
    .select({
      actionTaken: schema.auditLog.actionTaken,
      targetId: schema.auditLog.targetId,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'linq_message_edited'),
        eq(schema.auditLog.targetId, channelMessageId),
      ),
    );
  return rows.filter(
    (row) => row.actionTaken === 'linq_message_edited' && row.targetId === channelMessageId,
  ).length;
}

/**
 * Bubbles in this chat the model may still edit: one text part, sent within
 * Linq's window, under the edit cap, and tied to the transcript row that holds
 * the words. The receipt of an edit is not itself a bubble.
 */
export async function listEditableLinqSends(
  database: Database,
  input: { familyId: string; conversationId: string; chatId: string; now: Date },
): Promise<EditableLinqSend[]> {
  const cutoff = new Date(input.now.getTime() - LINQ_EDIT_WINDOW_MS);
  const channelRows = await database
    .select({
      id: schema.channelMessages.id,
      familyId: schema.channelMessages.familyId,
      channel: schema.channelMessages.channel,
      direction: schema.channelMessages.direction,
      providerChatId: schema.channelMessages.providerChatId,
      providerMessageId: schema.channelMessages.providerMessageId,
      templateKey: schema.channelMessages.templateKey,
      sentAt: schema.channelMessages.sentAt,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.channel, 'imessage'),
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.providerChatId, input.chatId),
        gte(schema.channelMessages.sentAt, cutoff),
      ),
    );
  const sends = channelRows.filter((row) => {
    const sentAt = asDate(row.sentAt);
    return (
      row.familyId === input.familyId &&
      row.channel === 'imessage' &&
      row.direction === 'out' &&
      row.providerChatId === input.chatId &&
      row.templateKey !== 'linq:edit' &&
      typeof row.providerMessageId === 'string' &&
      row.providerMessageId.length > 0 &&
      sentAt !== null &&
      sentAt.getTime() >= cutoff.getTime()
    );
  });

  const bubbles = await database
    .select({
      conversationId: schema.messages.conversationId,
      role: schema.messages.role,
      content: schema.messages.content,
      providerMessageId: schema.messages.providerMessageId,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, input.conversationId));
  const textByProvider = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const bubble of bubbles) {
    if (bubble.conversationId !== input.conversationId) continue;
    if (bubble.role !== 'assistant' || bubble.deletedAt) continue;
    if (typeof bubble.providerMessageId !== 'string' || bubble.providerMessageId.length === 0) {
      continue;
    }
    if (typeof bubble.content !== 'string' || bubble.content.length === 0) continue;
    if (textByProvider.has(bubble.providerMessageId)) {
      ambiguous.add(bubble.providerMessageId);
      continue;
    }
    textByProvider.set(bubble.providerMessageId, bubble.content);
  }

  const byMessage = new Map<string, typeof sends>();
  for (const send of sends) {
    const id = send.providerMessageId as string;
    const list = byMessage.get(id) ?? [];
    list.push(send);
    byMessage.set(id, list);
  }

  const candidates: EditableLinqSend[] = [];
  for (const [messageId, rows] of byMessage) {
    if (rows.length !== 1 || ambiguous.has(messageId)) continue;
    const text = textByProvider.get(messageId);
    const send = rows[0];
    if (!text || !send) continue;
    const used = await editsUsed(database, send.id);
    if (used >= LINQ_EDIT_MAX) continue;
    const sentAt = asDate(send.sentAt);
    if (!sentAt) continue;
    candidates.push({
      messageId,
      partIndex: 0,
      text,
      sentAt: sentAt.toISOString(),
      editsUsed: used,
      channelMessageId: send.id,
    });
  }
  candidates.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
  return candidates.slice(0, 5);
}

type Rewrite = 'updated' | 'unchanged' | 'missing';

async function rewriteAssistantBubble(
  database: Database,
  providerMessageId: string,
  text: string,
): Promise<Rewrite> {
  const rows = await database
    .select({
      id: schema.messages.id,
      role: schema.messages.role,
      content: schema.messages.content,
      providerMessageId: schema.messages.providerMessageId,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.providerMessageId, providerMessageId));
  const matches = rows.filter(
    (row) =>
      row.providerMessageId === providerMessageId &&
      row.role === 'assistant' &&
      !row.deletedAt &&
      typeof row.id === 'string',
  );
  if (matches.length !== 1) return 'missing';
  const match = matches[0];
  if (!match) return 'missing';
  if (match.content === text) return 'unchanged';
  await database
    .update(schema.messages)
    .set({ content: text })
    .where(eq(schema.messages.id, match.id as string));
  return 'updated';
}

async function auditEdit(
  database: Database,
  input: { familyId: string; parentUserId: string; channelMessageId: string; actionTaken: string },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.parentUserId,
    actionTaken: input.actionTaken,
    targetTable: 'channel_messages',
    targetId: input.channelMessageId,
  });
}

export type LinqEditOutcome =
  | { status: 'edited'; channelMessageId: string }
  | { status: 'declined' }
  | {
      status: 'not_edited';
      reason: 'model_failed' | 'refused' | 'not_configured' | 'unreachable';
      code?: string;
    };

/**
 * Ask the model, then PATCH the part it rewrote. Never throws. The follow-up
 * is sent only when this does not return `edited`.
 */
export async function applyLinqEdit(input: {
  decider: LinqEditDecider;
  database: Database;
  familyId: string;
  parentUserId: string;
  conversationId: string;
  chatId: string;
  now: Date;
  read: { audience: 'direct' | 'group'; parentText: string; followUp: string };
  candidates: readonly EditableLinqSend[];
  fetch?: typeof fetch;
}): Promise<LinqEditOutcome> {
  if (input.candidates.length === 0) return { status: 'declined' };
  const decision = await input.decider.decide({
    audience: input.read.audience,
    parentText: input.read.parentText,
    followUp: input.read.followUp,
    editable: input.candidates,
  });
  if (!decision) return { status: 'not_edited', reason: 'model_failed' };
  if (decision.edit === null) return { status: 'declined' };
  const candidate = input.candidates.find((row) => row.messageId === decision.edit?.messageId);
  if (!candidate || decision.edit.partIndex !== candidate.partIndex) {
    return { status: 'not_edited', reason: 'model_failed' };
  }
  try {
    await editLinqMessage({
      messageId: candidate.messageId,
      text: decision.edit.text,
      partIndex: decision.edit.partIndex,
      fetch: input.fetch,
    });
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      console.warn({ reason: 'not_configured' }, 'linq edit: not edited');
      return { status: 'not_edited', reason: 'not_configured', code: err.code };
    }
    if (err instanceof LinqSendError && (err.code === 'timeout' || err.code === 'network')) {
      console.warn({ code: err.code }, 'linq edit: unreachable, the follow-up still goes out');
      return { status: 'not_edited', reason: 'unreachable', code: err.code };
    }
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    const httpStatus = err instanceof LinqSendError ? err.httpStatus : 0;
    console.warn({ code, httpStatus }, 'linq edit: refused, the follow-up still goes out');
    return { status: 'not_edited', reason: 'refused', code };
  }

  let channelMessageId = candidate.channelMessageId;
  try {
    const wrote = await rewriteAssistantBubble(
      input.database,
      candidate.messageId,
      decision.edit.text,
    );
    if (wrote === 'updated') {
      await auditEdit(input.database, {
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        channelMessageId: candidate.channelMessageId,
        actionTaken: 'linq_message_edited',
      });
    }
    const [receipt] = await input.database
      .insert(schema.channelMessages)
      .values({
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        channel: 'imessage',
        direction: 'out',
        category: 'reply',
        templateKey: 'linq:edit',
        providerMessageId: candidate.messageId,
        providerChatId: input.chatId,
        status: acceptedStatus('imessage'),
        relatedConversationId: input.conversationId,
        sentAt: input.now,
      })
      .returning({ id: schema.channelMessages.id });
    if (receipt?.id) channelMessageId = receipt.id;
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'linq edit: the bubble changed; the ledger row did not',
    );
  }
  return { status: 'edited', channelMessageId };
}

async function channelRowsFor(database: Database, providerMessageId: string) {
  const rows = await database
    .select({
      id: schema.channelMessages.id,
      familyId: schema.channelMessages.familyId,
      parentUserId: schema.channelMessages.parentUserId,
      direction: schema.channelMessages.direction,
      providerMessageId: schema.channelMessages.providerMessageId,
      body: schema.channelMessages.body,
      templateKey: schema.channelMessages.templateKey,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.providerMessageId, providerMessageId));
  return rows.filter((row) => row.providerMessageId === providerMessageId);
}

/**
 * Apply a `message.edited` webhook. Our own edit rewrites the transcript bubble
 * when the text differs; a parent's edit rewrites the inbound body. A retry
 * that already matches writes nothing. The text is never logged.
 */
export async function recordLinqEditWebhook(
  database: Database,
  edit: LinqMessageEdit,
): Promise<'updated' | 'unchanged' | 'unknown_message'> {
  const rows = await channelRowsFor(database, edit.messageId);
  if (rows.length === 0) return 'unknown_message';
  const ours = edit.direction === 'outbound' || (edit.direction === null && edit.isFromMe);
  if (!ours) {
    const inbound = rows.find((row) => row.direction === 'in');
    if (!inbound) return 'unknown_message';
    if (inbound.body === edit.text) return 'unchanged';
    await database
      .update(schema.channelMessages)
      .set({ body: edit.text })
      .where(eq(schema.channelMessages.id, inbound.id));
    await auditEdit(database, {
      familyId: inbound.familyId,
      parentUserId: inbound.parentUserId,
      channelMessageId: inbound.id,
      actionTaken: 'linq_parent_message_edited',
    });
    return 'updated';
  }
  const original = rows.find((row) => row.direction === 'out' && row.templateKey !== 'linq:edit');
  const wrote = await rewriteAssistantBubble(database, edit.messageId, edit.text);
  if (wrote === 'missing') return original ? 'unchanged' : 'unknown_message';
  if (wrote === 'unchanged') return 'unchanged';
  if (original) {
    await auditEdit(database, {
      familyId: original.familyId,
      parentUserId: original.parentUserId,
      channelMessageId: original.id,
      actionTaken: 'linq_message_edited',
    });
  }
  return 'updated';
}
