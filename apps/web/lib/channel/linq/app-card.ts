import { type Database, schema } from '@hale/db';
import { acceptedStatus } from '~/lib/channel/ledger';
import { checkLinqIMessageCapability, sendLinqParts } from '~/lib/channel/outbound-transport';
import { linqAppCardsEnabled, linqIMessageAppIdentity } from './config';
import { type LinqLinkPreviewOutcome, sendLinqLinkPreview } from './link-preview';
import { type LinqIMessageAppCardWire, LinqSendError } from './transport';

/**
 * VIL-480 — an iMessage app card (activity / event: name, time, venue, image) instead of
 * a bare link, with a fallback when it cannot render.
 *
 * Hale's AI decides when a card fits and writes every field; this module holds no copy.
 * It is only the wire plus the rules Linq documents:
 *   - iMessage only, and the `imessage_app` part must be alone in its message.
 *   - The card is drawn by the Messages extension named in LINQ_IMESSAGE_APP_* — an
 *     identity the recipient lacks drops to caption text, silently.
 *   - The body (`fallback_text`, else `caption`) must carry no time, date, address,
 *     phone, or day word, or iMessage shows it as a plain text instead of a card. So
 *     the model's `fallbackText` is required and checked here; rich detail goes in
 *     caption/subcaption/image fields.
 *   - `image_title`/`image_subtitle` need `image_url`; https only, 2048 max.
 *
 * Fallback: anything that keeps the card from going out (flag dark, no app identity, not
 * iMessage, capability says no, a refused or invalid card) sends the card's `url` as
 * the existing rich link preview instead — never a second text Hale did not write.
 *
 * https://docs.linqapp.com/channel/imessage/guides/messaging/imessage-apps/
 */

const URL_MAX = 2048;
const OVERLAY_MAX = 512;
const CAPTION_MAX = 512;

export interface LinqAppCardInput {
  /** https; the extension reads it to render the live card. Also the fallback link. */
  url: string;
  /** Model-written; free of times, dates, addresses, phones, and day words. */
  fallbackText: string;
  caption?: string;
  subcaption?: string;
  trailingCaption?: string;
  trailingSubcaption?: string;
  imageUrl?: string;
  imageTitle?: string;
  imageSubtitle?: string;
  /** false → always the static layout card, even for recipients with the app. */
  interactive?: boolean;
}

export type LinqAppCardRefusal =
  | 'dark'
  | 'no_app_identity'
  | 'not_imessage'
  | 'no_chat'
  | 'not_capable'
  | 'invalid_card'
  | 'unsafe_fallback_text'
  | 'refused'
  | 'unreachable'
  | 'not_configured';

export type LinqAppCardOutcome =
  | { status: 'card'; providerMessageId: string }
  | { status: 'fallback'; why: LinqAppCardRefusal; link: LinqLinkPreviewOutcome };

/**
 * What iMessage reads as "not a card": a clock time, a date, a street address, a phone
 * number, or a day word. Conservative on purpose: a false positive costs the card (link
 * fallback), a false negative costs a bubble that reads as a stray text.
 */
const UNSAFE_BODY: readonly RegExp[] = [
  /\b\d{1,2}(:\d{2})\s*(am|pm)?\b/i,
  /\b\d{1,2}\s*(am|pm|a\.m\.|p\.m\.)/i,
  /\b(today|tonight|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i,
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i,
  /\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\+?\d[\d\s().-]{6,}\d/,
  /\b\d+\s+\w+(\s\w+)?\s+(st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|way|ct|court|pl|place|cres|crescent)\b/i,
  // fr / zh day words — Hale writes in the family's language.
  /(aujourd'hui|demain|hier|ce soir|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)/i,
  /(今天|明天|昨天|今晚|周[一二三四五六日天]|星期[一二三四五六日天])/,
];

export function appCardBodyIsSafe(body: string): boolean {
  return !UNSAFE_BODY.some((re) => re.test(body));
}

function httpsUrl(raw: string | undefined): string | null {
  if (!raw || raw.length > URL_MAX) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function field(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) throw new LinqSendError('invalid_card', 400, true);
  return trimmed;
}

/** The wire card, or a refusal naming why. Pure; no env read beyond the identity passed. */
export function buildLinqAppCard(
  input: LinqAppCardInput,
  app: LinqIMessageAppCardWire['app'],
):
  | { ok: true; card: LinqIMessageAppCardWire }
  | { ok: false; why: 'invalid_card' | 'unsafe_fallback_text' } {
  const url = httpsUrl(input.url);
  if (!url) return { ok: false, why: 'invalid_card' };
  const fallbackText = input.fallbackText?.trim();
  if (!fallbackText || fallbackText.length > CAPTION_MAX) return { ok: false, why: 'invalid_card' };
  if (!appCardBodyIsSafe(fallbackText)) return { ok: false, why: 'unsafe_fallback_text' };
  let layout: LinqIMessageAppCardWire['layout'];
  try {
    const imageUrl = input.imageUrl === undefined ? undefined : httpsUrl(input.imageUrl);
    if (imageUrl === null) return { ok: false, why: 'invalid_card' };
    layout = {
      caption: field(input.caption, CAPTION_MAX),
      subcaption: field(input.subcaption, CAPTION_MAX),
      trailing_caption: field(input.trailingCaption, CAPTION_MAX),
      trailing_subcaption: field(input.trailingSubcaption, CAPTION_MAX),
      image_url: imageUrl,
      image_title: field(input.imageTitle, OVERLAY_MAX),
      image_subtitle: field(input.imageSubtitle, OVERLAY_MAX),
    };
  } catch {
    return { ok: false, why: 'invalid_card' };
  }
  for (const key of Object.keys(layout) as Array<keyof typeof layout>) {
    if (layout[key] === undefined) delete layout[key];
  }
  if (Object.keys(layout).length === 0) return { ok: false, why: 'invalid_card' };
  if ((layout.image_title || layout.image_subtitle) && !layout.image_url) {
    return { ok: false, why: 'invalid_card' };
  }
  return {
    ok: true,
    card: {
      app,
      url,
      fallback_text: fallbackText,
      ...(input.interactive === false ? { interactive: false } : {}),
      layout,
    },
  };
}

export async function sendLinqAppCard(input: {
  channel: string;
  chatId: string | null;
  card: LinqAppCardInput;
  /** The 1:1 recipient's handle, for the cached iMessage capability check. Omit in a group. */
  recipientAddress?: string;
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
    console.info({ why, link: link.status }, 'linq app card: fell back to link preview');
    return { status: 'fallback', why, link };
  };

  if (!linqAppCardsEnabled()) return fallback('dark');
  if (input.channel !== 'imessage') return fallback('not_imessage');
  if (!input.chatId) return fallback('no_chat');
  const app = linqIMessageAppIdentity();
  if (!app) return fallback('no_app_identity');
  const built = buildLinqAppCard(input.card, app);
  if (!built.ok) return fallback(built.why);

  if (input.recipientAddress) {
    try {
      const capability = await checkLinqIMessageCapability({
        address: input.recipientAddress,
        fetch: input.fetch,
      });
      // `unknown` (dark check, outage, rate limit) is not a no: the chat is already
      // iMessage, and a later 4005 `message.failed` is the async backstop.
      if (capability.status === 'not_available') return fallback('not_capable');
    } catch {
      // A refused check never blocks the card; same reasoning as `unknown`.
    }
  }

  try {
    const sent = await sendLinqParts({
      chatId: input.chatId,
      parts: [{ type: 'imessage_app', card: built.card }],
      fetch: input.fetch,
    });
    if (input.database && input.familyId && input.parentUserId) {
      await input.database.insert(schema.channelMessages).values({
        familyId: input.familyId,
        parentUserId: input.parentUserId,
        channel: 'imessage',
        direction: 'out',
        category: 'reply',
        templateKey: 'linq:app_card',
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
      { code, httpStatus: err instanceof LinqSendError ? err.httpStatus : undefined },
      'linq app card: refused',
    );
    return fallback('refused');
  }
}
