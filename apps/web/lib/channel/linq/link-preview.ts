import { type Database, schema } from '@hale/db';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import {
  plainTextWithoutLinks,
  readSendRefusal,
  sendLinqParts,
} from '~/lib/channel/outbound-transport';
import { LinqSendError } from './transport';

/**
 * VIL-335 — a rich link preview beside a locked text, never instead of it.
 *
 * A Linq `link` part has to be the only part in its message. Design-locked
 * copy that already contains the URL stays byte-stable as a text part. This
 * sends a second message that is only the link, which is what renders the
 * preview card. A refusal does not fail the text that already went out.
 *
 * VIL-573 · A link Hale writes into a text goes out ONCE. {@link liftPreviewLink} takes
 * it out of the text, and {@link sendLinkOnce} sends it after that text: the preview
 * bubble on iMessage, or the bare URL as its own text where the preview cannot go.
 */

const URL_IN_TEXT = /https:\/\/[^\s)]+/;

/** The first https URL in a body, unless it is a policy page. */
export function linkPreviewUrl(body: string): string | null {
  const match = URL_IN_TEXT.exec(body);
  if (!match) return null;
  const url = match[0].replace(/[.,]$/, '');
  if (url.includes('/privacy') || url.includes('/terms')) return null;
  return url;
}

const ANY_URL = /https?:\/\/\S+/g;

/**
 * The text without its link, plus the link, when the body carries exactly one
 * previewable link and words beside it. Null otherwise, and the body goes as written:
 * with two links, lifting one would orphan the sentence that names it.
 */
export function liftPreviewLink(body: string): { text: string; url: string } | null {
  if ((body.match(ANY_URL) ?? []).length !== 1) return null;
  const url = linkPreviewUrl(body);
  if (!url) return null;
  const text = plainTextWithoutLinks(body);
  if (!text) return null;
  return { text, url };
}

export type LinkOnceOutcome =
  | { status: 'preview'; providerMessageId: string }
  /** The preview did not go, so the URL went as its own text. `why` names the preview's refusal. */
  | { status: 'text'; why: LinkPreviewRefusal; providerMessageId: string }
  /** Neither went. The text before it reached the parent without a link. */
  | { status: 'not_sent'; why: LinkPreviewRefusal; code: string };

type LinkPreviewRefusal = Extract<LinqLinkPreviewOutcome, { status: 'not_sent' }>['reason'];

/**
 * The link, once, after a text that does not carry it. Each send has its own ledger
 * row and audit row.
 */
export async function sendLinkOnce(input: {
  transport: ChannelTransport;
  to: string;
  channel: string;
  chatId: string | null;
  url: string;
  database: Database;
  familyId: string;
  parentUserId: string;
  now: Date;
  fetch?: typeof fetch;
}): Promise<LinkOnceOutcome> {
  const preview = await sendLinqLinkPreview({
    channel: input.channel,
    chatId: input.chatId,
    url: input.url,
    fetch: input.fetch,
    database: input.database,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    now: input.now,
  });
  if (preview.status === 'sent') {
    return { status: 'preview', providerMessageId: preview.providerMessageId };
  }
  const why = preview.reason;
  let sent: Awaited<ReturnType<ChannelTransport['send']>>;
  try {
    sent = await input.transport.send({ to: input.to, body: input.url });
  } catch (err) {
    const code = readSendRefusal(err)?.code ?? 'unknown';
    console.error({ why, code }, 'link once: no preview and the link text was refused');
    return { status: 'not_sent', why, code };
  }
  const channel = sent.transport === 'imessage' ? 'imessage' : 'sms';
  const [row] = await input.database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel,
      direction: 'out',
      category: 'reply',
      templateKey: 'linq:link_text',
      providerMessageId: sent.providerMessageId,
      providerChatId: channel === 'imessage' ? (sent.chatId ?? input.chatId) : null,
      status: acceptedStatus(channel),
      sentAt: input.now,
    })
    .returning({ id: schema.channelMessages.id });
  if (row?.id) {
    await input.database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.parentUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: row.id,
    });
  }
  if (why !== 'not_imessage') {
    console.warn({ why }, 'link once: no preview; the link went as its own text');
  }
  return { status: 'text', why, providerMessageId: sent.providerMessageId };
}

export type LinqLinkPreviewOutcome =
  | { status: 'sent'; providerMessageId: string }
  | { status: 'not_sent'; reason: 'no_url' | 'not_imessage' | 'no_chat' }
  | {
      status: 'not_sent';
      reason: 'refused' | 'not_configured' | 'unreachable';
      code: string;
      httpStatus?: number;
    };

export async function sendLinqLinkPreview(input: {
  channel: string;
  chatId: string | null;
  url: string | null;
  fetch?: typeof fetch;
  /** When the family exists, the follow-up link is its own ledger row. */
  database?: Database;
  familyId?: string;
  parentUserId?: string;
  now?: Date;
}): Promise<LinqLinkPreviewOutcome> {
  if (input.channel !== 'imessage') return { status: 'not_sent', reason: 'not_imessage' };
  if (!input.chatId) return { status: 'not_sent', reason: 'no_chat' };
  if (!input.url || !input.url.startsWith('https://'))
    return { status: 'not_sent', reason: 'no_url' };
  try {
    const sent = await sendLinqParts({
      chatId: input.chatId,
      parts: [{ type: 'link', value: input.url }],
      fetch: input.fetch,
    });
    if (input.database && input.familyId && input.parentUserId) {
      const [row] = await input.database
        .insert(schema.channelMessages)
        .values({
          familyId: input.familyId,
          parentUserId: input.parentUserId,
          channel: 'imessage',
          direction: 'out',
          category: 'reply',
          templateKey: 'linq:link_preview',
          providerMessageId: sent.providerMessageId,
          providerChatId: input.chatId,
          status: acceptedStatus('imessage'),
          sentAt: input.now ?? new Date(),
        })
        .returning({ id: schema.channelMessages.id });
      if (row?.id) {
        await input.database.insert(schema.auditLog).values({
          familyId: input.familyId,
          actor: input.parentUserId,
          actionTaken: 'linq_link_preview',
          targetTable: 'channel_messages',
          targetId: row.id,
        });
      }
    }
    return { status: 'sent', providerMessageId: sent.providerMessageId };
  } catch (err) {
    if (!(err instanceof LinqSendError)) {
      console.warn({ code: 'unknown' }, 'linq link preview: refused — the text already went out');
      return { status: 'not_sent', reason: 'refused', code: 'unknown' };
    }
    if (err.code === 'not_configured') {
      return { status: 'not_sent', reason: 'not_configured', code: err.code };
    }
    if (err.code === 'timeout' || err.code === 'network') {
      console.warn(
        { code: err.code },
        'linq link preview: unreachable — the text already went out',
      );
      return { status: 'not_sent', reason: 'unreachable', code: err.code };
    }
    console.warn(
      { code: err.code, httpStatus: err.httpStatus },
      'linq link preview: refused — the text already went out',
    );
    return { status: 'not_sent', reason: 'refused', code: err.code, httpStatus: err.httpStatus };
  }
}
