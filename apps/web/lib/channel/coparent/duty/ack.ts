import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { LinqSendError, reactToLinqMessage, sendLinqChatMessage } from '~/lib/channel/linq/transport';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { dutyOwnerEcho, dutyTitleMayBeSpoken } from './copy';
import { coparentDutyMemoryEnabled } from './flag';

/**
 * LLM writes get one restate line (locked owner sentence plus the locked
 * next step). Deterministic hits get a tapback and no text. Neither leaves
 * during quiet hours, and neither starts a 1:1: the chat has to be the one
 * the parent just used.
 */

const QUIET_START = '21:00:00';
const QUIET_END = '08:00:00';

export function dutyQuietHours(now: Date, timeZone: string): boolean {
  return isWithinQuietHours(now, timeZone, QUIET_START, QUIET_END);
}

/** Hale does not open a 1:1. Replies only happen on a chat the parent just used. */
export function dutyMayInitiateOneToOne(): false {
  return false;
}

export type DutyAck =
  | { status: 'tapback'; sent: false; text: null }
  | { status: 'restated'; sent: true; text: string }
  | { status: 'held'; reason: 'quiet_hours'; sent: false; text: null }
  | {
      status: 'skipped';
      reason:
        | 'flag_off'
        | 'no_proactive_1to1'
        | 'copy_locked'
        | 'non_kid_title'
        | 'not_configured'
        | 'placeholder';
      sent: false;
      text: null;
    };

export async function acknowledgeDutyWrite(input: {
  database: Database;
  familyId: string;
  actorUserId: string;
  source: 'rules' | 'llm' | 'text' | 'poll' | 'tapback';
  now: Date;
  timeZone: string;
  inboundChatId: string | null;
  inboundMessageId: string | null;
  language: 'en' | 'fr';
  name: string | null;
  kid: string | null;
  event: string | null;
  day: string | null;
  time: string | null;
  fetch?: typeof fetch;
}): Promise<DutyAck> {
  const skip = (
    reason: Extract<DutyAck, { status: 'skipped' }>['reason'],
  ): DutyAck => ({ status: 'skipped', reason, sent: false, text: null });
  if (!coparentDutyMemoryEnabled()) return skip('flag_off');
  if (dutyQuietHours(input.now, input.timeZone)) {
    return { status: 'held', reason: 'quiet_hours', sent: false, text: null };
  }
  if (!input.inboundChatId) return skip('no_proactive_1to1');
  if (input.event && !dutyTitleMayBeSpoken(input.event)) return skip('non_kid_title');

  const templateKey = input.source === 'llm' ? 'linq:duty_restate' : 'linq:duty_tapback';
  const line =
    input.source === 'llm'
      ? dutyOwnerEcho(input.language, {
          name: input.name,
          kid: input.kid,
          event: input.event,
          day: input.day,
          time: input.time,
        })
      : null;
  if (input.source === 'llm' && !line) return skip('copy_locked');
  if (input.source !== 'llm' && !input.inboundMessageId) return skip('no_proactive_1to1');

  const [claimed] = await input.database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.actorUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey,
      dedupeKey: `linq:duty_ack:${input.familyId}:${input.inboundMessageId ?? input.now.toISOString()}`,
      providerChatId: input.inboundChatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return skip('not_configured');

  const markFailed = async (code: string) => {
    await input.database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code })
      .where(eq(schema.channelMessages.id, claimed.id));
  };

  if (input.source === 'llm' && line) {
    try {
      await sendLinqChatMessage({
        chatId: input.inboundChatId,
        text: line,
        fetch: input.fetch,
      });
      return { status: 'restated', sent: true, text: line };
    } catch (err) {
      if (err instanceof LinqSendError && err.code === 'not_configured') {
        await markFailed('not_configured');
        return skip('not_configured');
      }
      throw err;
    }
  }

  try {
    await reactToLinqMessage({
      messageId: input.inboundMessageId as string,
      operation: 'add',
      type: 'like',
      fetch: input.fetch,
    });
    return { status: 'tapback', sent: false, text: null };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      await markFailed('not_configured');
      console.info({ reason: 'not_configured' }, 'duty memory: tapback was not sent');
      return skip('not_configured');
    }
    throw err;
  }
}
