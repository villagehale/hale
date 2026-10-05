import type { ReplyLanguage } from '../language';
import type { SpokenLineInput } from '../voice/judge';

/**
 * VIL-413 / VIL-417 · what the model is handed for every word the connect-by-text door
 * says: the link offer, the two-link offer, and the three ways a disconnect ends.
 *
 * Until this change these were locked sentences in connect/copy.ts (the offer with its
 * "Good for 15 minutes", the fixed Google "unverified app" caution in front of it, and
 * three disconnect receipts). They are gone. Code supplies the facts (which account, how
 * long the link lives, what Google's button is called), appends the real URL after the
 * prose, and the judge holds the limits.
 *
 * Pure, relative imports only: the worker eval loads this module through tsx.
 */

export const CONNECT_VOICE_SKILL = 'connect-voice';

/** Two short sentences with a product name and a button word in them. */
export const CONNECT_MAX_CHARS = 220;

/** CHANNEL_SIGNIN_TTL_MS, said out loud. The number the line promises. */
export const CONNECT_LINK_MINUTES = 15;

export type ConnectAccount = 'gcal' | 'gmail' | 'gdrive';

/** What each connector is called to a parent. 'Google Agenda' is the product's own French name. */
export const CONNECT_ACCOUNT_NAME: Record<ReplyLanguage, Record<ConnectAccount, string>> = {
  en: { gcal: 'Google Calendar', gmail: 'Gmail', gdrive: 'Google Drive' },
  fr: { gcal: 'Google Agenda', gmail: 'Gmail', gdrive: 'Google Drive' },
};

/** The word on Google's unverified-app screen, per language. A fact the model must carry. */
export const GOOGLE_ADVANCED_BUTTON: Record<ReplyLanguage, string> = {
  en: 'Advanced',
  fr: 'Paramètres avancés',
};

export type ConnectLineRequest =
  | { kind: 'offer'; account: ConnectAccount }
  | { kind: 'offer_both'; first: ConnectAccount; second: ConnectAccount }
  | { kind: 'revoked'; account: ConnectAccount }
  | { kind: 'not_connected'; account: ConnectAccount }
  | { kind: 'revoke_failed'; account: ConnectAccount }
  | { kind: 'mint_failed'; account: ConnectAccount };

export type ConnectLineKind = ConnectLineRequest['kind'];

/** The door's own red line: the words that were on the old receipts and must not come back. */
export const NO_CONNECT_KEYWORD_ASK = {
  name: 'keyword_ask',
  pattern:
    /(?<![\p{L}])(?:reply|text|say|send|answer|r[ée]pond(?:s|ez)|[ée]cri(?:s|vez)|dis|dites|envoie|envoyez)\s+(?:with\s+|avec\s+|me\s+|moi\s+)?["'«]?(?:CONNECT|LINK|CALENDAR|GMAIL|YES|OUI|STOP|START|CONNECTE[RZ]?|LIE[RZ]?)(?![\p{L}])/iu,
};

/** Hale never saw a password and never changed anything on Google's side. */
export const NO_GOOGLE_SIDE_CLAIM = {
  name: 'google_side_claim',
  pattern:
    /\b(?:your password|ton mot de passe|disconnected\b[^.!?]{0,40}\bfrom google|told google|removed\b[^.!?]{0,40}\bfrom google|d[ée]connect[ée]\b[^.!?]{0,40}\bde google|retir[ée]\b[^.!?]{0,40}\bde google)\b/i,
};

/**
 * Facts, limits, and anchors for one connect line. Always one parent in their own thread
 * (tu): the household group has its own voice for its own asks (linq/group-line-input.ts).
 */
export function connectLineInput(
  request: ConnectLineRequest,
  language: ReplyLanguage,
  options: { parentWords?: string | null } = {},
): SpokenLineInput {
  const base = {
    skill: CONNECT_VOICE_SKILL,
    kind: request.kind,
    language,
    address: 'tu' as const,
    questions: 0 as const,
    maxChars: CONNECT_MAX_CHARS,
    parentWords: options.parentWords ?? null,
    forbidden: [NO_CONNECT_KEYWORD_ASK, NO_GOOGLE_SIDE_CLAIM],
  };
  const name = (account: ConnectAccount) => CONNECT_ACCOUNT_NAME[language][account];
  const button = GOOGLE_ADVANCED_BUTTON[language];
  const minutes = String(CONNECT_LINK_MINUTES);

  switch (request.kind) {
    case 'offer':
      return {
        ...base,
        linkFollows: true,
        facts: {
          account: name(request.account),
          goodForMinutes: CONNECT_LINK_MINUTES,
          googleButton: button,
        },
        mustMention: [name(request.account), minutes, button],
      };
    case 'offer_both':
      return {
        ...base,
        linkFollows: true,
        facts: {
          first: name(request.first),
          second: name(request.second),
          goodForMinutes: CONNECT_LINK_MINUTES,
          googleButton: button,
        },
        mustMention: [name(request.first), name(request.second), minutes, button],
      };
    case 'revoked':
      return {
        ...base,
        linkFollows: true,
        facts: { account: name(request.account), keysDeleted: true, googleStillListsHale: true },
        mustMention: [name(request.account)],
      };
    case 'not_connected':
      return {
        ...base,
        facts: { account: name(request.account), connected: false },
        mustMention: [name(request.account)],
      };
    case 'revoke_failed':
      return {
        ...base,
        facts: { account: name(request.account), changed: false },
        mustMention: [name(request.account)],
      };
    case 'mint_failed':
      return {
        ...base,
        facts: { account: name(request.account), changed: false },
        mustMention: [name(request.account)],
      };
  }
}

/** Where a parent removes Hale from their own Google account. Appended by code, never spoken. */
export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

/** The prose, then the real link(s) on their own line(s). The model never sees a URL. */
export function withConnectLinks(line: string, urls: readonly string[]): string {
  return [line.trim(), ...urls].join('\n');
}
