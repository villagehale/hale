import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { ReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus } from '~/lib/channel/ledger';
import {
  type SpokenLineComposer,
  type SpokenLineFallback,
  speakLine,
} from '~/lib/channel/voice/spoken-line';
import { GROUP_ROLE_ASK_LOCKED } from './group-onboarding-copy';
import {
  type GroupOnboardingKind,
  type GroupOnboardingRequest,
  groupOnboardingLineInput,
} from './group-onboarding-line-input';
import { LinqSendError, sendLinqChatMessage } from './transport';

/**
 * Group onboarding v2 — say one who's-who line into the group.
 *
 * The model writes it (spoken-line engine, skill `group-onboarding-voice`); code owns the
 * facts and the ledger. Claim, send, stamp: the `channel_messages` row is the claim, so a
 * line goes out at most once per dedupe key, and `sms_reply_sent` is audited only after
 * it lands. A line the model could not write is `group_line_unsent`, audited, sends
 * nothing and claims nothing, so the next inbound in that chat tries again. The asks are
 * the exception: a person must still be asked, so an unsent ask falls back once to the
 * locked sentence, tagged `locked` and audited. A refused send releases its dedupe key.
 */

export type GroupLineSend = (input: {
  chatId: string;
  text: string;
  replyTo?: string;
}) => Promise<{ providerMessageId: string }>;

export type GroupLineSource = 'composed' | 'retry' | 'locked';

export type GroupLineOutcome =
  | { outcome: 'sent'; source: GroupLineSource }
  | { outcome: 'already_sent' }
  | { outcome: 'not_sent'; code: string }
  | { outcome: 'group_line_unsent'; fallback: SpokenLineFallback };

const LOCKED_FALLBACK: Partial<Record<GroupOnboardingKind, string>> = {
  roster_ask: GROUP_ROLE_ASK_LOCKED,
  member_ask: GROUP_ROLE_ASK_LOCKED,
};

interface SpokenGroupLine {
  body: string;
  source: GroupLineSource | 'unsent';
  fallback: SpokenLineFallback | null;
}

async function speak(
  voice: SpokenLineComposer | undefined,
  request: GroupOnboardingRequest,
  language: ReplyLanguage,
  parentWords: string | null,
  scope: { familyId: string; database: Database } | undefined,
): Promise<SpokenGroupLine> {
  const spoken = await speakLine(
    voice,
    groupOnboardingLineInput(request, language, { parentWords }),
    scope ? { scope } : {},
  );
  if (spoken.source !== 'unsent') return spoken;
  const locked = LOCKED_FALLBACK[request.kind];
  if (!locked) return spoken;
  return { body: locked, source: 'locked', fallback: spoken.fallback };
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
    voice: SpokenLineComposer | undefined;
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
  if (spoken.source === 'locked') {
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: 'system',
      actionTaken: 'group_line_locked_fallback',
      targetTable: 'channel_messages',
      targetId: input.familyId,
      after: { kind, fallback: spoken.fallback },
    });
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
  voice: SpokenLineComposer | undefined;
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
