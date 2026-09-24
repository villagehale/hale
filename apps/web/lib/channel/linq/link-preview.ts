import { type Database, schema } from '@hale/db';
import { acceptedStatus } from '~/lib/channel/ledger';
import { LinqSendError, sendLinqParts } from './transport';

/**
 * VIL-335 — a rich link preview beside a locked text, never instead of it.
 *
 * A Linq `link` part has to be the only part in its message. Design-locked
 * copy that already contains the URL stays byte-stable as a text part. This
 * sends a second message that is only the link, which is what renders the
 * preview card. A refusal does not fail the text that already went out.
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
