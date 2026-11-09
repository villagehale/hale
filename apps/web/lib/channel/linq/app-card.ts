import { type Database, schema } from '@hale/db';
import { acceptedStatus } from '~/lib/channel/ledger';
import { checkLinqIMessageCapability, sendLinqExperience } from '~/lib/channel/outbound-transport';
import { parentFacingActivityUrl } from '~/lib/format/http-url';
import { linqExperiencesEnabled } from './config';
import { type LinqLinkPreviewOutcome, sendLinqLinkPreview } from './link-preview';
import { type LinqExperienceWire, LinqSendError } from './transport';

/**
 * VIL-480 — an activity/event card instead of a bare link, sent as a Linq **experience**
 * (`link` / `open`): Linq's own iMessage app renders it. No Hale Messages extension, no
 * team/bundle id, no borrowed identity (Design lock: `imessage_app` without an extension
 * silently becomes caption text, so it is not used).
 *
 * Hale's AI decides when a card fits and writes every field; this module holds no copy.
 * It is only the wire plus the rules Linq documents:
 *   - iMessage only; the card is the whole message (`experience`, never `parts`).
 *   - One recipient per action, so a group chat never gets a card.
 *   - `link`/`open` declares `url` (https, ≤2048, required) and `title` (≤64). Unknown
 *     params are a 400, so nothing else is sent.
 *   - Recipients without Linq's app see a static card built from the same copy.
 *
 * `fallbackText` is the transport copy field (wire `params.title`, the copy the static
 * card is built from). Design lock: the model writes it freely — activity cards may name
 * times and places. Transport keeps only real constraints: trimmed non-empty (else
 * omitted) and ≤64 chars.
 *
 * Fallback: anything that keeps the card from going out (flag dark, not iMessage, group,
 * capability says no, invalid card, refused) sends the card's `url` as the existing rich
 * link preview instead — never a second text Hale did not write.
 *
 * https://docs.linqapp.com/channel/imessage/guides/messaging/experiences/
 */

const URL_MAX = 2048;
const TITLE_MAX = 64;

export interface LinqAppCardInput {
  /** https; the card opens it. Also the link-preview fallback. */
  url: string;
  /** Model-written card copy (wire `title`). Written freely; may include times/places. ≤64 chars. */
  fallbackText?: string;
}

export type LinqAppCardRefusal =
  | 'dark'
  | 'not_imessage'
  | 'no_chat'
  | 'group_chat'
  | 'not_capable'
  | 'invalid_card'
  | 'refused'
  | 'unreachable'
  | 'not_configured';

export type LinqAppCardOutcome =
  | { status: 'card'; providerMessageId: string }
  | {
      status: 'fallback';
      why: LinqAppCardRefusal;
      link: LinqLinkPreviewOutcome;
    };

function httpsUrl(raw: string | undefined): string | null {
  if (!raw || raw.length > URL_MAX) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  // VIL-510 · Wiki / encyclopedia hosts are not activity pages for a card or preview.
  return parentFacingActivityUrl(raw);
}

/** The wire experience, or a refusal naming why. Pure. */
export function buildLinqAppCard(
  input: LinqAppCardInput,
): { ok: true; experience: LinqExperienceWire } | { ok: false; why: 'invalid_card' } {
  const url = httpsUrl(input.url);
  if (!url) return { ok: false, why: 'invalid_card' };
  const title = input.fallbackText?.trim();
  if (title !== undefined && title.length > TITLE_MAX) return { ok: false, why: 'invalid_card' };
  return {
    ok: true,
    experience: {
      name: 'link',
      action: 'open',
      params: { url, ...(title ? { title } : {}) },
    },
  };
}

export async function sendLinqAppCard(input: {
  channel: string;
  chatId: string | null;
  card: LinqAppCardInput;
  /** The 1:1 recipient's handle (capability check). Required: an experience has one recipient. */
  recipientAddress?: string;
  /** True for a group chat — experiences go to exactly one recipient, so it falls back. */
  isGroup?: boolean;
  fetch?: typeof fetch;
  database?: Database;
  familyId?: string;
  parentUserId?: string;
  now?: Date;
}): Promise<LinqAppCardOutcome> {
  const fallback = async (why: LinqAppCardRefusal): Promise<LinqAppCardOutcome> => {
    const link = await sendLinqLinkPreview({
      channel: input.channel,
      chatId: input.chatId,
      url: httpsUrl(input.card.url),
      fetch: input.fetch,
      database: input.database,
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      now: input.now,
    });
    console.info({ why, link: link.status }, 'linq experience card: fell back to link preview');
    return { status: 'fallback', why, link };
  };

  if (!linqExperiencesEnabled()) return fallback('dark');
  if (input.channel !== 'imessage') return fallback('not_imessage');
  if (!input.chatId) return fallback('no_chat');
  if (input.isGroup) return fallback('group_chat');
  const built = buildLinqAppCard(input.card);
  if (!built.ok) return fallback(built.why);

  if (input.recipientAddress) {
    try {
      const capability = await checkLinqIMessageCapability({
        address: input.recipientAddress,
        fetch: input.fetch,
      });
      // `unknown` is not a no; a later 4005 `message.failed` is the async backstop.
      if (capability.status === 'not_available') return fallback('not_capable');
    } catch {
      // A refused check never blocks the card.
    }
  }

  try {
    const sent = await sendLinqExperience({
      chatId: input.chatId,
      experience: built.experience,
      fetch: input.fetch,
    });
    if (input.database && input.familyId && input.parentUserId) {
      await input.database.insert(schema.channelMessages).values({
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        channel: 'imessage',
        direction: 'out',
        category: 'reply',
        templateKey: 'linq:experience_card',
        providerMessageId: sent.providerMessageId,
        providerChatId: input.chatId,
        status: acceptedStatus('imessage'),
        sentAt: input.now ?? new Date(),
      });
    }
    return { status: 'card', providerMessageId: sent.providerMessageId };
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    if (code === 'not_configured') return fallback('not_configured');
    if (code === 'timeout' || code === 'network') return fallback('unreachable');
    console.warn(
      {
        code,
        httpStatus: err instanceof LinqSendError ? err.httpStatus : undefined,
      },
      'linq experience card: refused',
    );
    return fallback('refused');
  }
}
