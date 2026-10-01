import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import { linqPhoneOutboundConfigured } from '~/lib/channel/linq/config';
import { LinqSendError, createLinqPhoneTransport } from '~/lib/channel/linq/transport';
import type { MessageTransport } from '~/lib/channel/transport-address';
import { TwilioSendError, createTwilioTransport } from '~/lib/channel/twilio/transport';

/**
 * The one place a Hale-initiated text chooses its phone door.
 *
 * Default is Linq on `LINQ_FROM_E164` (iMessage, then RCS, then SMS). Twilio is
 * constructed only when `OUTBOUND_TRANSPORT` is exactly `twilio`. Anything else,
 * including unset, is Linq. A deploy with no Linq key and no Linq line does not
 * fall through to Twilio: the send throws `LinqSendError` `not_configured`, and
 * the caller records that skip.
 *
 * Callers ledger beside the send. This module does not.
 */
export function createOutboundTransport(deps: { fetch?: typeof fetch } = {}): ChannelTransport {
  if (process.env.OUTBOUND_TRANSPORT === 'twilio') return createTwilioTransport(deps);
  if (!linqPhoneOutboundConfigured()) {
    return {
      async send() {
        throw new LinqSendError('not_configured', 0, true);
      },
    };
  }
  return createLinqPhoneTransport(deps);
}

/** The pipe a failed attempt is recorded on, when the send never reported one. */
export function configuredOutboundChannel(): 'sms' | 'imessage' {
  return process.env.OUTBOUND_TRANSPORT === 'twilio' ? 'sms' : 'imessage';
}

/** A typed provider refusal, or null when the throw is not one of the two doors. */
export function readSendRefusal(err: unknown): { code: string; permanent: boolean } | null {
  if (err instanceof LinqSendError || err instanceof TwilioSendError) {
    return { code: err.code, permanent: err.permanent };
  }
  return null;
}

/**
 * Permanent refusals are not retried. `not_configured` is permanent at the
 * provider and transient for the sweep: a later tick sends once the door exists.
 */
export function refusalStopsRetry(err: unknown): boolean {
  const refusal = readSendRefusal(err);
  return refusal?.permanent === true && refusal.code !== 'not_configured';
}

/**
 * A pre-claimed ledger row after a refusal. `not_configured` drops the dedupe
 * key so the next tick can claim again; every other code keeps it.
 */
export function failedSendPatch(code: string): {
  status: 'failed';
  errorCode: string;
  dedupeKey?: null;
} {
  if (code === 'not_configured') {
    return { status: 'failed', errorCode: code, dedupeKey: null };
  }
  return { status: 'failed', errorCode: code };
}

const URL_IN_TEXT = /https?:\/\/\S+/gi;

/** The same sentence with URLs removed. Other wording, including STOP, stays. */
export function plainTextWithoutLinks(body: string): string {
  return body
    .replace(URL_IN_TEXT, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type ResolvedOutbound = {
  providerMessageId: string;
  transport?: MessageTransport;
  chatId?: string | null;
  linkOmitted?: 'link_on_new_chat';
};

/**
 * One send. A new Linq 1:1 that refuses a URL is retried once as the same
 * sentence with the URL removed, and that second id is the one the caller
 * ledgers. Media is never dropped: `media_on_new_chat` is rethrown. A body
 * that is only a URL is rethrown so the caller records the permanent skip.
 */
export async function sendResolvingNewChat(
  transport: ChannelTransport,
  input: OutboundMessage,
): Promise<ResolvedOutbound> {
  try {
    return await transport.send(input);
  } catch (err) {
    const refusal = readSendRefusal(err);
    if (refusal?.code !== 'link_on_new_chat') throw err;
    if (input.mediaUrls?.length) throw err;
    const plain = plainTextWithoutLinks(input.body);
    if (!plain) throw err;
    console.warn(
      { code: 'link_on_new_chat' },
      'outbound: new Linq chat cannot take a link; plain-text version sent',
    );
    const sent = await transport.send({ to: input.to, body: plain });
    return { ...sent, linkOmitted: 'link_on_new_chat' };
  }
}
