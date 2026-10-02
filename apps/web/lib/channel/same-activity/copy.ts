import { safeGivenName } from '~/lib/channel/identity/parent-call-name';
import type { ReplyLanguage } from '~/lib/channel/language';

/**
 * Design-locked same-activity lines (byte-stable aside from `{activity}` and
 * `{firstName}`). French is the accent-free GSM-7 text that was locked.
 * A decline has no line: nothing is sent to the other household.
 */
export const SAME_ACTIVITY_OFFER_EN =
  "Another family nearby is looking at the same {activity}. Want me to check if they'd go together? I won't share anything about you unless they say yes too.";
export const SAME_ACTIVITY_OFFER_FR =
  'Une autre famille pres de chez vous regarde la meme activite: {activity}. Voulez-vous que je voie si elle serait partante pour y aller ensemble? Je ne partage rien sur vous sans son accord aussi.';
export const SAME_ACTIVITY_WAITING_EN =
  "Asked. If they're in, I'll let you know; if not, I won't bring it up again. Nothing to do for now.";
export const SAME_ACTIVITY_WAITING_FR =
  "C'est demande. Si elle est partante, je vous le dis; sinon, je n'en reparle pas. Rien a faire pour l'instant.";
export const SAME_ACTIVITY_CONFIRMATION_EN =
  "You're both up for it. The other parent is {firstName}, and they got your first name too. Want me to start a chat with the two of you?";
export const SAME_ACTIVITY_CONFIRMATION_FR =
  "Vous etes tous les deux partants. L'autre parent s'appelle {firstName}, et elle ou il a recu votre prenom aussi. Voulez-vous que je lance une conversation a deux?";

const OFFER: Record<ReplyLanguage, string> = {
  en: SAME_ACTIVITY_OFFER_EN,
  fr: SAME_ACTIVITY_OFFER_FR,
};
const WAITING: Record<ReplyLanguage, string> = {
  en: SAME_ACTIVITY_WAITING_EN,
  fr: SAME_ACTIVITY_WAITING_FR,
};
const CONFIRMATION: Record<ReplyLanguage, string> = {
  en: SAME_ACTIVITY_CONFIRMATION_EN,
  fr: SAME_ACTIVITY_CONFIRMATION_FR,
};

const BANNED_SEND = /reply stop|stop to opt out|\bunsubscribe\b/i;
const LABEL_MAX = 80;

/** A parent-facing activity name. Never the opaque key, an address, or a slot. */
export function sameActivityLabel(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const label = raw.trim();
  if (label.length < 1 || label.length > LABEL_MAX) return null;
  if (/[\r\n@{}|]/.test(label)) return null;
  return label;
}

/** The other parent's given name, first token only, or null when it is not speakable. */
export function sameActivityFirstName(raw: string | null | undefined): string | null {
  const safe = safeGivenName(raw);
  if (!safe) return null;
  const first = safe.split(' ')[0];
  if (!first || /[\r\n@{}|]/.test(first)) return null;
  return first;
}

function fill(template: string, slot: '{activity}' | '{firstName}', value: string): string {
  const parts = template.split(slot);
  if (parts.length !== 2) return template;
  return `${parts[0]}${value}${parts[1]}`;
}

function matchesLocked(template: string, text: string): boolean {
  if (!template.includes('{')) return text === template;
  const slot = template.includes('{activity}') ? '{activity}' : '{firstName}';
  const parts = template.split(slot);
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return false;
  if (!text.startsWith(parts[0]) || !text.endsWith(parts[1])) return false;
  const value = text.slice(parts[0].length, text.length - parts[1].length);
  return slot === '{activity}'
    ? sameActivityLabel(value) === value
    : sameActivityFirstName(value) === value;
}

/** True only for one of the six locked lines, with its slot filled by a safe value. */
export function sameActivityCopyMayLeave(text: string): boolean {
  if (text.includes('TODO-Design') || text.includes('\n') || BANNED_SEND.test(text)) return false;
  if (text.includes('{activity}') || text.includes('{firstName}')) return false;
  return [OFFER.en, OFFER.fr, WAITING.en, WAITING.fr, CONFIRMATION.en, CONFIRMATION.fr].some(
    (template) => matchesLocked(template, text),
  );
}

export interface SameActivityReply {
  text: string;
  mayLeave: boolean;
  language: ReplyLanguage;
}

function spoken(text: string, language: ReplyLanguage): SameActivityReply {
  return { text, mayLeave: sameActivityCopyMayLeave(text), language };
}

/**
 * The parent-facing sentence for one state.
 *
 * The offer names the activity and nobody else. Waiting names nobody.
 * The confirmation names the other parent's given name only once both
 * households have opted in. A decline is not a sentence.
 */
export function renderSameActivityReply(
  status: 'not_opted_in' | 'unread' | 'waiting' | 'mutual',
  options: { language?: ReplyLanguage; activity?: string; firstName?: string } = {},
): SameActivityReply {
  const language = options.language === 'fr' ? 'fr' : 'en';
  if (status === 'waiting') return spoken(WAITING[language], language);
  if (status === 'mutual') {
    const firstName = sameActivityFirstName(options.firstName);
    if (!firstName) return spoken('', language);
    return spoken(fill(CONFIRMATION[language], '{firstName}', firstName), language);
  }
  const activity = sameActivityLabel(options.activity);
  if (!activity) return spoken('', language);
  return spoken(fill(OFFER[language], '{activity}', activity), language);
}

/**
 * No transport is injected, so a locked line still does not leave. The skip
 * is named (rule #11). A decline is not this function: it has no text.
 */
export function deliverSameActivityReply(_text: string): {
  sent: false;
  skipped: 'not_configured';
} {
  return { sent: false, skipped: 'not_configured' };
}

/** A no is recorded for this household and is not a message to anyone else. */
export function sameActivityDeclineToOtherSide(): { sent: false; skipped: 'decline' } {
  return { sent: false, skipped: 'decline' };
}
