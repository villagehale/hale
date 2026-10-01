import type { Database } from '@hale/db';
import { captureAgentError } from '~/lib/analytics/server-capture';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { linqPhoneOutboundConfigured } from '~/lib/channel/linq/config';
import {
  type FamilyOutboundTarget,
  deliverFamilyOutbound,
  familySpeech,
} from '~/lib/channel/linq/family-outbound';
import { groupBothReaderFrench } from '~/lib/channel/linq/group-coparent-copy';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { createOutboundTransport, sendResolvingNewChat } from '~/lib/channel/outbound-transport';
import type { Channel } from '../types';

/**
 * The LOOP's SMS leg of the channel seam (VIL-213 · A2), lit up by VIL-260.
 *
 * A2 defined the seam and A3 (VIL-214) built the raw send behind M2's
 * `ChannelTransport`, which addresses a bare E.164 — the shape intake needs,
 * because intake has a number before it has an account. THIS seam is the other
 * shape: it is handed a `userId`. `resolveSendablePhone` (sms-consent-core) is
 * that reader, so the adapter composes the two rather than growing a third.
 *
 * The default transport is `createOutboundTransport` (Linq). A family with a
 * claimed group still goes to that group; a family without one is a Linq 1:1
 * on the Hale line, which falls through iMessage → RCS → SMS. A permanent
 * Linq refusal stays a non-transient error so a retry cannot re-earn it.
 *
 * Config is the Linq outbound pair (`LINQ_API_KEY` and `LINQ_FROM_E164`). A
 * deploy holding one of them skips cleanly rather than half-sending, and the
 * dispatch records the skip as a not_configured leg.
 *
 * Privacy (rule #1): the phone number and the rendered body are never logged.
 */

export interface SmsChannelDeps {
  /** Resolve an internal user id to a sendable E.164, or null when this parent has no
   * active verified SMS channel (prod: `resolveSendablePhone`). */
  resolveTarget(userId: string): Promise<string | null>;
  /** The shared outbound leg; defaults to `createOutboundTransport`. */
  transport?: ChannelTransport;
  /** Whether the outbound leg is provisioned; defaults to the Linq key and line. */
  configured?: boolean;
  /**
   * The family's home channel, when this parent belongs to one. Absent keeps
   * SMS, which is what every test double and every family without a group does.
   */
  familyTarget?(userId: string): Promise<FamilyOutboundTarget>;
  /** The database the group cap is counted on. Required when `familyTarget` is set. */
  database?: Database;
}

function defaultOutboundConfigured(): boolean {
  return linqPhoneOutboundConfigured();
}

export function createSmsChannel(deps: SmsChannelDeps): Channel {
  const transport = deps.transport ?? createOutboundTransport();
  return {
    kind: 'sms',
    async send({ userId, rendered }) {
      if (rendered.kind !== 'sms') {
        throw new Error(`sms adapter received ${rendered.kind} content`);
      }

      if (!(deps.configured ?? defaultOutboundConfigured())) {
        return { status: 'skipped', reason: 'not_configured' };
      }

      const to = await deps.resolveTarget(userId);
      if (!to) {
        return { status: 'skipped', reason: 'no_address' };
      }

      try {
        const target = deps.familyTarget
          ? await deps.familyTarget(userId)
          : { channel: 'legacy' as const };
        if (target.channel === 'group') {
          const database = deps.database ?? ({} as Database);
          const speech = await familySpeech(database, target.familyId, userId);
          const body =
            speech.language === 'fr' ? groupBothReaderFrench(rendered.text) : rendered.text;
          const delivered = await deliverFamilyOutbound(database, {
            familyId: target.familyId,
            body,
            to,
            legacy: transport,
            target,
            bubbleKind: 'weekly_followup',
            shareGroupCap: true,
          });
          if (delivered.status === 'held') {
            return {
              status: 'skipped',
              reason: 'disabled',
            };
          }
          if (delivered.status === 'skipped') {
            if (delivered.reason === 'not_configured') {
              return { status: 'skipped', reason: 'not_configured' };
            }
            return {
              status: 'error',
              transient: false,
              code: delivered.reason,
              message: 'linq refused the send',
            };
          }
          return {
            status: 'sent',
            providerMessageId: delivered.providerMessageId,
            providerChatId: delivered.chatId,
          };
        }
        const sent = await sendResolvingNewChat(transport, { to, body: rendered.text });
        return {
          status: 'sent',
          providerMessageId: sent.providerMessageId,
          ...(sent.chatId ? { providerChatId: sent.chatId } : {}),
        };
      } catch (error) {
        if (!(error instanceof LinqSendError)) throw error;
        // Reported at the point the refusal is CLASSIFIED. The error's message is
        // deliberately not passed — it can echo the recipient — and the reporter
        // has no field it would fit in.
        //
        // No family: this seam is addressed by `userId`, and a user id reported in a
        // field named for a family is a wrong grain that would silently mis-group every
        // co-parent. The dispatch already carries the per-family view of the same
        // failure on its ledger row (channel/dispatch.ts, loop_message_failed).
        await captureAgentError({
          lane: 'transport',
          code: error.code,
          retry: error.permanent ? 'permanent' : 'transient',
          familyId: null,
        });
        return {
          status: 'error',
          transient: !error.permanent,
          code: error.code,
          message: 'linq refused the send',
        };
      }
    },
  };
}
