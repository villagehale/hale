import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import { type GroupHoldReason, groupAudienceAllows } from '~/lib/channel/linq/group-audience';
import type { ListChatHandles } from '~/lib/channel/linq/roster';
import { LinqSendError, listLinqParticipantHandles } from '~/lib/channel/linq/transport';
import { reactToLinqMessage, sendLinqChatMessage } from '~/lib/channel/outbound-transport';
import { replyProse } from '~/lib/channel/reply-copy/apply';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import { dutyCopyMayLeave, dutyOwnerEcho, dutyTitleMayBeSpoken } from './copy';
import { coparentDutyMemoryEnabled } from './flag';

/**
 * LLM writes get one restate the model wrote. Deterministic hits get a
 * tapback and no text. A miss holds the text. Neither leaves during quiet
 * hours, and neither starts a 1:1: the chat has to be the one the parent
 * just used.
 *
 * In a family group the restatement is a `pickup_duty` line, so it goes only when the
 * family-chat floor allows it. When the floor refuses, nothing is written or sent into
 * the group; the parent's message gets the tapback instead (a reaction carries no
 * household content), and the outcome names the floor's reason.
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
  | { status: 'audience_held'; reason: GroupHoldReason; tapback: boolean; sent: false; text: null }
  | {
      status: 'skipped';
      reason:
        | 'flag_off'
        | 'no_proactive_1to1'
        | 'copy_locked'
        | 'model_unsent'
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
  /** `group` when the inbound came from a family group chat; `reply` for a 1:1. */
  surface: 'group' | 'reply';
  language: 'en' | 'fr';
  name: string | null;
  kid: string | null;
  event: string | null;
  day: string | null;
  time: string | null;
  fetch?: typeof fetch;
  replyClient?: AgentClient | null;
  listChatHandles?: ListChatHandles;
}): Promise<DutyAck> {
  const skip = (reason: Extract<DutyAck, { status: 'skipped' }>['reason']): DutyAck => ({
    status: 'skipped',
    reason,
    sent: false,
    text: null,
  });
  if (!coparentDutyMemoryEnabled()) return skip('flag_off');
  if (dutyQuietHours(input.now, input.timeZone)) {
    return { status: 'held', reason: 'quiet_hours', sent: false, text: null };
  }
  if (!input.inboundChatId) return skip('no_proactive_1to1');
  if (input.event && !dutyTitleMayBeSpoken(input.event)) return skip('non_kid_title');

  const plan =
    input.source === 'llm'
      ? dutyOwnerEcho(input.language, {
          name: input.name,
          kid: input.kid,
          event: input.event,
          day: input.day,
          time: input.time,
        })
      : null;
  if (input.source === 'llm' && !plan) return skip('copy_locked');
  const audience =
    input.source === 'llm' && input.surface === 'group'
      ? await groupAudienceAllows(
          input.database,
          input.inboundChatId,
          'pickup_duty',
          input.listChatHandles ??
            ((i) => listLinqParticipantHandles({ ...i, fetch: input.fetch })),
        )
      : null;
  const heldBy = audience && !audience.allowed ? audience.reason : null;
  const audienceHeld = (reason: GroupHoldReason, tapback: boolean): DutyAck => {
    console.info(
      { outcome: 'duty_restate_held', reason, tapback },
      'duty memory: the family group may not hear the restatement',
    );
    return { status: 'audience_held', reason, tapback, sent: false, text: null };
  };
  const restate = input.source === 'llm' && !heldBy;
  const templateKey = restate ? 'linq:duty_restate' : 'linq:duty_tapback';
  const facts = [input.name, input.kid, input.event, input.day, input.time].flatMap((value) =>
    value?.trim() ? [value.trim()] : [],
  );
  const line =
    restate && plan
      ? await replyProse(
          {
            client: await resolveReplyClient(input.replyClient),
            database: input.database,
            familyId: input.familyId,
            language: input.language,
            audience: 'direct',
            surface: 'duty',
          },
          { purpose: plan.purpose, questionAllowed: plan.questionAllowed, facts },
        )
      : null;
  if (restate && (!line || !dutyCopyMayLeave(line))) return skip('model_unsent');
  if (!restate && !input.inboundMessageId) {
    return heldBy ? audienceHeld(heldBy, false) : skip('no_proactive_1to1');
  }

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

  if (restate && line) {
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
    return heldBy ? audienceHeld(heldBy, true) : { status: 'tapback', sent: false, text: null };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      await markFailed('not_configured');
      console.info({ reason: 'not_configured' }, 'duty memory: tapback was not sent');
      return skip('not_configured');
    }
    throw err;
  }
}
