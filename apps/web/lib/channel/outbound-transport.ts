import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import { linqApiKey, linqFromE164, linqPhoneOutboundConfigured } from '~/lib/channel/linq/config';
import * as linq from '~/lib/channel/linq/transport';
import { LinqSendError, createLinqPhoneTransport } from '~/lib/channel/linq/transport';
import {
  capturePreviewChatOp,
  createPreviewCaptureTransport,
  previewCaptureRequested,
} from '~/lib/channel/preview-capture-transport';
import type { MessageTransport } from '~/lib/channel/transport-address';

/**
 * The one place a Hale-initiated text chooses its phone door.
 *
 * Linq on `LINQ_FROM_E164` (iMessage, then RCS, then SMS). A deploy with no Linq
 * key and no Linq line throws `LinqSendError` `not_configured`, and the caller
 * records that skip.
 *
 * Callers ledger beside the send. This module does not.
 */
export function createOutboundTransport(deps: { fetch?: typeof fetch } = {}): ChannelTransport {
  // Preview proof runs only. Throws (never falls through to Linq) when the
  // flag is on outside preview or beside a configured Linq door.
  if (previewCaptureRequested()) return createPreviewCaptureTransport();
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
export function configuredOutboundChannel(): 'imessage' {
  return 'imessage';
}

/** A typed Linq refusal, or null when the throw is not one. */
export function readSendRefusal(err: unknown): { code: string; permanent: boolean } | null {
  if (err instanceof LinqSendError) {
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

/*
 * Chat-addressed sends. Every Linq call that puts something in front of a parent
 * (a chat message, parts, a reaction, a new chat, a roster or name change, typing,
 * read receipts, a contact card, a poll, an effect, a location request) is made
 * through one of these, never by importing linq/transport directly
 * (one-door.test.ts enforces it).
 *
 * Capture flag off: each one is exactly the linq/transport call, same arguments,
 * same result, same throw. Capture flag on: the call is recorded and nothing goes
 * to the network, after the same refusals as `createOutboundTransport` (preview
 * only, no Linq key, no Linq line).
 */

type In<F extends (...args: never[]) => unknown> = Parameters<F>[0];

function captured(op: string, input: object): string {
  return capturePreviewChatOp(op, input as Record<string, unknown>).providerMessageId;
}

/** True when a chat-addressed send can be attempted: a Linq key, or capture on. */
export function outboundChatConfigured(): boolean {
  return previewCaptureRequested() || linqApiKey() !== null;
}

/**
 * The line a new chat is opened from, or null when there is none. Capture on
 * returns a placeholder so a proof run reaches the (captured) create call.
 */
export function outboundLineFrom(): string | null {
  if (previewCaptureRequested()) return 'preview-capture-line';
  return linqApiKey() !== null ? linqFromE164() : null;
}

export async function sendLinqChatMessage(
  input: In<typeof linq.sendLinqChatMessage>,
): Promise<{ providerMessageId: string }> {
  if (previewCaptureRequested()) return { providerMessageId: captured('chat_message', input) };
  return linq.sendLinqChatMessage(input);
}

export async function sendLinqParts(
  input: In<typeof linq.sendLinqParts>,
): Promise<{ providerMessageId: string }> {
  if (previewCaptureRequested()) return { providerMessageId: captured('parts', input) };
  return linq.sendLinqParts(input);
}

export async function sendLinqEffect(
  input: In<typeof linq.sendLinqEffect>,
): Promise<{ providerMessageId: string }> {
  if (previewCaptureRequested()) return { providerMessageId: captured('effect', input) };
  return linq.sendLinqEffect(input);
}

export async function reactToLinqMessage(
  input: In<typeof linq.reactToLinqMessage>,
): Promise<{ accepted: true }> {
  if (previewCaptureRequested()) {
    captured('reaction', input);
    return { accepted: true };
  }
  return linq.reactToLinqMessage(input);
}

export async function createLinqChat(
  input: In<typeof linq.createLinqChat>,
): Promise<{ chatId: string; providerMessageId: string }> {
  if (previewCaptureRequested()) {
    const id = captured('create_chat', input);
    return { chatId: `${id}-chat`, providerMessageId: id };
  }
  return linq.createLinqChat(input);
}

export async function updateLinqGroupChat(
  input: In<typeof linq.updateLinqGroupChat>,
): Promise<linq.LinqEffectResult> {
  if (previewCaptureRequested()) {
    captured('update_group', input);
    return { status: 'accepted' };
  }
  return linq.updateLinqGroupChat(input);
}

export async function addLinqParticipant(
  input: In<typeof linq.addLinqParticipant>,
): Promise<{ accepted: true }> {
  if (previewCaptureRequested()) {
    captured('add_participant', input);
    return { accepted: true };
  }
  return linq.addLinqParticipant(input);
}

export async function removeLinqParticipant(
  input: In<typeof linq.removeLinqParticipant>,
): Promise<{ accepted: true }> {
  if (previewCaptureRequested()) {
    captured('remove_participant', input);
    return { accepted: true };
  }
  return linq.removeLinqParticipant(input);
}

export async function shareLinqContactCard(
  input: In<typeof linq.shareLinqContactCard>,
): Promise<{ accepted: true }> {
  if (previewCaptureRequested()) {
    captured('share_contact_card', input);
    return { accepted: true };
  }
  return linq.shareLinqContactCard(input);
}

export async function setupLinqContactCard(
  input: In<typeof linq.setupLinqContactCard>,
): Promise<linq.LinqEffectResult> {
  if (previewCaptureRequested()) {
    captured('setup_contact_card', input);
    return { status: 'accepted' };
  }
  return linq.setupLinqContactCard(input);
}

export async function patchLinqContactCard(
  input: In<typeof linq.patchLinqContactCard>,
): Promise<linq.LinqEffectResult> {
  if (previewCaptureRequested()) {
    captured('patch_contact_card', input);
    return { status: 'accepted' };
  }
  return linq.patchLinqContactCard(input);
}

export async function sendLinqPoll(
  input: In<typeof linq.sendLinqPoll>,
): Promise<{ messageId: string; options: linq.LinqPollOptionRef[] }> {
  if (previewCaptureRequested()) {
    const id = captured('poll', input);
    return {
      messageId: id,
      options: input.options.map((text, i) => ({ optionId: `${id}-option-${i}`, text })),
    };
  }
  return linq.sendLinqPoll(input);
}

function capturedEffect(op: string, input: object): Promise<linq.LinqEffectResult> {
  captured(op, input);
  return Promise.resolve({ status: 'accepted' });
}

export function markLinqChatRead(
  input: In<typeof linq.markLinqChatRead>,
): Promise<linq.LinqEffectResult> {
  if (previewCaptureRequested()) return capturedEffect('mark_read', input);
  return linq.markLinqChatRead(input);
}

export function startLinqTyping(
  input: In<typeof linq.startLinqTyping>,
): Promise<linq.LinqEffectResult> {
  if (previewCaptureRequested()) return capturedEffect('typing_start', input);
  return linq.startLinqTyping(input);
}

export function stopLinqTyping(
  input: In<typeof linq.stopLinqTyping>,
): Promise<linq.LinqEffectResult> {
  if (previewCaptureRequested()) return capturedEffect('typing_stop', input);
  return linq.stopLinqTyping(input);
}

/**
 * The transport for one iMessage turn, bound to the chat the parent texted.
 * Capture flag off: exactly `createLinqTextTransport`. On: the same contract,
 * with the send and the location request recorded instead of sent.
 */
export function createChatReplyTransport(
  deps: In<typeof linq.createLinqTextTransport>,
): ChannelTransport {
  if (!previewCaptureRequested()) return linq.createLinqTextTransport(deps);
  return {
    async send(input) {
      if (input.mediaUrls) throw new LinqSendError('media_unsupported', 400, true);
      if (!deps.chatId) throw new LinqSendError('missing_chat_id', 400, true);
      const providerMessageId = captured('chat_message', {
        chatId: deps.chatId,
        text: input.body,
        replyTo: deps.replyToMessageId ? { messageId: deps.replyToMessageId } : undefined,
      });
      return { providerMessageId, transport: 'imessage', chatId: deps.chatId };
    },
    async requestLocation() {
      if (!deps.chatId) return { status: 'refused', code: 'missing_chat_id' };
      captured('location_request', { chatId: deps.chatId });
      return { status: 'sent' };
    },
  };
}
