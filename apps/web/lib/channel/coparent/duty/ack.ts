import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { SEND_RETRIES_EXHAUSTED } from '~/lib/channel/config';
import {
  type GroupHoldReason,
  chatFloorAllows,
  sendFlooredChatMessage,
} from '~/lib/channel/linq/group-audience';
import type { ListChatHandles } from '~/lib/channel/linq/roster';
import {
  LinqSendError,
  SEND_TIMEOUT_MS,
  listLinqParticipantHandles,
} from '~/lib/channel/linq/transport';
import {
  reactToLinqMessage,
  refusalIsRateLimit,
  refusalStopsRetry,
} from '~/lib/channel/outbound-transport';
import { replyProse } from '~/lib/channel/reply-copy/apply';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { isWithinQuietHours } from '~/lib/loop/prefs';
import type { OpsPager } from '~/lib/monitoring/failure-page';
import { dutyCopyMayLeave, dutyOwnerEcho, dutyTitleMayBeSpoken } from './copy';
import { coparentDutyMemoryEnabled } from './flag';
import {
  DUTY_ACK_KEY_PREFIX,
  defaultDutyPager,
  dutyAttemptKey,
  dutyFailureCode,
  dutySendClaim,
  isLastDutySendTry,
  markDutySendAccepted,
  settleDutySendFailure,
} from './send-receipt';

/**
 * LLM writes get one restate the model wrote. Deterministic hits get a
 * tapback and no text. A miss holds the text. Neither leaves during quiet
 * hours, and neither starts a 1:1: the chat has to be the one the parent
 * just used.
 *
 * The restatement is a `pickup_duty` line. Unless the chat is the parent's own recorded
 * 1:1, it goes only when the family-chat floor allows it. When the floor refuses, nothing
 * is written or sent into the chat; the parent's message gets the tapback instead (a
 * reaction carries no household content), and the outcome names the floor's reason.
 */

/** A further tapback is only for a failure that can clear by itself, and only while one
 * whole send still lands before Linq stops waiting on this webhook (`answerBy`). */
function tapbackMayRetry(err: LinqSendError, answerBy: Date | undefined, nowMs: number): boolean {
  if (refusalStopsRetry(err) || refusalIsRateLimit(err)) return false;
  return answerBy !== undefined && nowMs + SEND_TIMEOUT_MS <= answerBy.getTime();
}

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
        | 'placeholder'
        | typeof SEND_RETRIES_EXHAUSTED;
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
  replyClient?: AgentClient | null;
  listChatHandles?: ListChatHandles;
  pager?: OpsPager;
  clockMs?: () => number;
  /** When Linq stops waiting on the webhook this runs inside. Absent outside a webhook. */
  answerBy?: Date;
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
    input.source === 'llm'
      ? await chatFloorAllows(input.database, {
          chatId: input.inboundChatId,
          recipientUserId: input.actorUserId,
          lineClass: 'pickup_duty',
          listChatHandles:
            input.listChatHandles ??
            ((i) => listLinqParticipantHandles({ ...i, fetch: input.fetch })),
        })
      : null;
  const heldBy = audience && !audience.allowed ? audience.reason : null;
  const audienceHeld = (reason: GroupHoldReason, tapback: boolean): DutyAck => {
    console.info(
      { outcome: 'duty_restate_held', reason, tapback },
      'duty memory: the family group may not hear the restatement',
    );
    return { status: 'audience_held', reason, tapback, sent: false, text: null };
  };
  const pass = audience?.allowed ? audience.pass : null;
  const restate = pass !== null;
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

  const baseKey = `${DUTY_ACK_KEY_PREFIX}${input.familyId}:${input.inboundMessageId ?? input.now.toISOString()}`;
  const pager = input.pager ?? defaultDutyPager(input.database);
  const clockMs = input.clockMs ?? Date.now;
  for (let attempt = 1; ; attempt += 1) {
    const [claimed] = await input.database
      .insert(schema.channelMessages)
      .values({
        familyId: input.familyId,
        parentUserId: input.actorUserId,
        channel: 'imessage',
        direction: 'out',
        category: 'reply',
        templateKey,
        dedupeKey: dutyAttemptKey(baseKey, attempt),
        providerChatId: input.inboundChatId,
        ...dutySendClaim(input.now),
      })
      .returning({ id: schema.channelMessages.id });
    if (!claimed) return skip('not_configured');
    const failure = {
      familyId: input.familyId,
      claimId: claimed.id,
      attempt,
      surface: 'ack',
      audience: input.actorUserId,
      pager,
    } as const;

    try {
      if (pass && line) {
        await sendFlooredChatMessage(pass, 'pickup_duty', {
          chatId: input.inboundChatId,
          text: line,
          sendKey: baseKey,
          fetch: input.fetch,
        });
      } else {
        await reactToLinqMessage({
          messageId: input.inboundMessageId as string,
          operation: 'add',
          type: 'like',
          fetch: input.fetch,
        });
      }
    } catch (err) {
      if (!(err instanceof LinqSendError)) {
        await settleDutySendFailure(input.database, {
          ...failure,
          code: dutyFailureCode(err),
          final: true,
        });
        throw err;
      }
      if (err.code === 'not_configured') {
        await input.database
          .update(schema.channelMessages)
          .set({ status: 'failed', errorCode: err.code })
          .where(eq(schema.channelMessages.id, claimed.id));
        console.info({ reason: err.code }, 'duty memory: the ack was not sent');
        return skip('not_configured');
      }
      // A restatement gets one try: another would need a model call inside the webhook.
      const final =
        restate || isLastDutySendTry(attempt) || !tapbackMayRetry(err, input.answerBy, clockMs());
      await settleDutySendFailure(input.database, {
        ...failure,
        code: dutyFailureCode(err),
        final,
      });
      if (final) return skip(SEND_RETRIES_EXHAUSTED);
      continue;
    }

    await markDutySendAccepted(input.database, {
      familyId: input.familyId,
      claimId: claimed.id,
      now: input.now,
      providerMessageId: null,
      attempt,
      surface: 'ack',
      audience: input.actorUserId,
    });
    if (pass && line) return { status: 'restated', sent: true, text: line };
    return heldBy ? audienceHeld(heldBy, true) : { status: 'tapback', sent: false, text: null };
  }
}
