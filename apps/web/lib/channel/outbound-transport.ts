import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import { linqPhoneOutboundConfigured } from '~/lib/channel/linq/config';
import {
  LinqSendError,
  createLinqPhoneTransport,
  sendLinqChatMessage,
} from '~/lib/channel/linq/transport';
import { persistCapturedSend } from '~/lib/channel/preview-capture-store';
import {
  PreviewCaptureRefused,
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
  if (previewCaptureRequested()) {
    return createPreviewCaptureTransport(process.env, async (send) => {
      // The capture already happened in memory, so the caller's ledger row says
      // sent. A failed write is logged by name (never the body) and surfaces in the
      // proof read-back as `uncapturedLedgered` > 0 (countUncapturedLedgerRows).
      try {
        await persistCapturedSend(send);
      } catch (err) {
        console.error(
          {
            code: 'preview_capture_persist_failed',
            providerMessageId: send.providerMessageId,
            err: err instanceof Error && err.message ? err.message : String(err),
          },
          'outbound: preview capture not persisted; read-back will show a mismatch',
        );
      }
    });
  }
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
  // A capture run refusing a real recipient is permanent: retrying cannot help.
  if (err instanceof PreviewCaptureRefused) {
    return { code: `preview_${err.reason}`, permanent: true };
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

/**
 * Where a set of texts goes: one person (a phone), or a group thread (the
 * iMessage chat id, `in_group`), since a group reply belongs in the thread.
 */
export type TextsTarget =
  | { kind: 'person'; to: string }
  | { kind: 'group'; chatId: string; inGroup: true };

/** The dedupe key of text `index` in a set: the set's key with a `:i` suffix. */
export function textDedupeKey(setKey: string, index: number): string {
  return `${setKey}:${index}`;
}

export type SendTextsOutcome<R> =
  | { status: 'sent'; sent: Array<{ index: number; result: R }>; alreadySent: number[] }
  | { status: 'held'; reason: 'quiet_hours' }
  | {
      status: 'failed';
      /** The first text that did not go. Nothing after it was attempted. */
      failedAt: number;
      error: unknown;
      sent: Array<{ index: number; result: R }>;
      alreadySent: number[];
    };

/**
 * Several texts as one message, the way a friend types them (VIL-467).
 *
 * - In order, each send awaited before the next starts.
 * - Quiet hours are checked ONCE for the whole set, before the first text, so a set
 *   is never split across the quiet-hours line.
 * - One ledger row per text, keyed `<setKey>:<i>`. A retry asks `alreadySent` for
 *   each key and sends only the texts that did not go, starting at the first unsent.
 * - A failure stops the set where it is. Nothing is sent in its place: no sorry, no
 *   fallback, no summary text. A transient failure is rethrown (after the rows for
 *   the texts that did go are written) so the caller's queue retries the rest.
 *
 * The per-text `send` is injectable: the default uses `transport` and `target`
 * (`sendResolvingNewChat` for a person, the Linq chat for a group); the loop dispatch
 * passes its channel adapter instead so its policy seams stay the one choke point.
 */
export async function sendTexts<R = ResolvedOutbound>(input: {
  texts: readonly string[];
  setKey: string | null;
  target?: TextsTarget;
  transport?: ChannelTransport;
  send?: (text: string, index: number) => Promise<R>;
  /** True when this text's key already carries a send. Absent: nothing was sent yet. */
  alreadySent?: (key: string) => Promise<boolean>;
  /** Write the ledger row for one text that went. */
  record: (row: { index: number; key: string | null; text: string; result: R }) => Promise<void>;
  /** Checked once for the whole set. Absent: deliverable. */
  deliverableNow?: () => boolean | Promise<boolean>;
  /** A thrown error that should be rethrown for a queue retry. Default: none. */
  isTransient?: (err: unknown) => boolean;
}): Promise<SendTextsOutcome<R>> {
  const texts = input.texts.map((t) => t.trim());
  if (texts.length === 0 || texts.some((t) => t === '')) {
    throw new Error('sendTexts: every text must be non-empty');
  }
  if (input.deliverableNow && !(await input.deliverableNow())) {
    return { status: 'held', reason: 'quiet_hours' };
  }
  const send = input.send ?? defaultTextSender<R>(input.target, input.transport);
  const sent: Array<{ index: number; result: R }> = [];
  const alreadySent: number[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index] as string;
    const key = input.setKey ? textDedupeKey(input.setKey, index) : null;
    if (key && input.alreadySent && (await input.alreadySent(key))) {
      alreadySent.push(index);
      continue;
    }
    let result: R;
    try {
      result = await send(text, index);
    } catch (error) {
      if (input.isTransient?.(error)) throw error;
      return { status: 'failed', failedAt: index, error, sent, alreadySent };
    }
    await input.record({ index, key, text, result });
    sent.push({ index, result });
  }
  return { status: 'sent', sent, alreadySent };
}

function defaultTextSender<R>(
  target: TextsTarget | undefined,
  transport: ChannelTransport | undefined,
): (text: string) => Promise<R> {
  if (!target) throw new Error('sendTexts: a target or a send function is required');
  if (target.kind === 'group') {
    // A preview proof run never reaches a real group thread: the capture transport
    // is phone-only, so a group set must pass its own `send` there.
    if (previewCaptureRequested()) {
      throw new Error('sendTexts: group target under preview capture needs an injected send');
    }
    return async (text) =>
      (await sendLinqChatMessage({ chatId: target.chatId, text })) as unknown as R;
  }
  if (!transport) throw new Error('sendTexts: a person target needs a transport');
  return async (text) =>
    (await sendResolvingNewChat(transport, { to: target.to, body: text })) as unknown as R;
}
