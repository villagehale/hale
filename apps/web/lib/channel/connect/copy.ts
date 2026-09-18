import type { ReplyLanguage } from '~/lib/channel/language';
import { failureReply } from '~/lib/channel/router/copy';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';
import type { ConnectorRevokeOutcome } from './revoke';

/**
 * The connector offer — the one deterministic line that hands a parent their sign-in
 * link. Locked copy (scanned by sms-copy-encoding.test.ts): plain hyphens, straight
 * quotes, GSM-7 throughout, one segment WITH the link inside it, and an FR twin per
 * the `_BY_LANGUAGE` convention — written inside GSM-7's French subset (é è à ù yes;
 * â ê î ô û ç no).
 *
 * The register is the Instinct one: short, zero ceremony, no exclamation marks. The
 * fifteen-minute clause is the TTL said out loud — CHANNEL_SIGNIN_TTL_MS is the number
 * this sentence promises, and the segment test holds both twins to one segment so the
 * link can never be split off its sentence.
 */

/** What each connector is called to a parent, per language. 'Google Agenda' is the
 * product's own French name, not a translation choice. */
const PROVIDER_NOUN: Record<ReplyLanguage, Record<ConnectorProvider, string>> = {
  en: { gcal: 'Google Calendar', gmail: 'Gmail', gdrive: 'Google Drive' },
  fr: { gcal: 'Google Agenda', gmail: 'Gmail', gdrive: 'Google Drive' },
};

const OFFER_BY_LANGUAGE: Record<ReplyLanguage, (noun: string, url: string) => string> = {
  en: (noun, url) => `Here you go - tap to connect your ${noun}: ${url} Good for 15 minutes.`,
  fr: (noun, url) => `Voici - touchez pour connecter votre ${noun}: ${url} Bon pour 15 minutes.`,
};

/** The whole reply, link included — composed here and nowhere else, so the sentence
 * and the URL cannot be split by any later fitting. */
export function connectorOfferReply(
  language: ReplyLanguage,
  provider: ConnectorProvider,
  url: string,
): string {
  return OFFER_BY_LANGUAGE[language](PROVIDER_NOUN[language][provider], url);
}

/**
 * THE DISCONNECT RECEIPTS — the other half of the same promise.
 *
 * Three things every one of them keeps:
 *
 *  1. It never claims more than happened. `revoked` says Hale deleted ITS keys and, in
 *     the same breath, that Google keeps its own record until the parent removes it at
 *     myaccount.google.com/permissions — the same truth the Settings surface already
 *     tells (settings/connector-actions.ts). Hale does not call Google's revoke
 *     endpoint, so a receipt that said "disconnected from Google" would be the one lie
 *     this flow cannot afford: a parent who checks and sees Hale still listed would be
 *     right to conclude nothing happened.
 *  2. `not_connected` is not a false success. Nothing of theirs matched, and the reply
 *     says so and hands back the words that connect one.
 *  3. The failure twin exists in BOTH languages. `failureReply()` is English-only by
 *     signature, so the French parent gets a French failure here rather than an English
 *     sentence at the worst moment of the turn.
 *
 * GSM-7 and one segment, both twins, asserted in sms-copy-encoding.test.ts — including
 * that the removal URL survives any later edit.
 */
const REVOKE_BY_LANGUAGE: Record<
  ReplyLanguage,
  Record<ConnectorRevokeOutcome['status'], (noun: string) => string>
> = {
  en: {
    revoked: (noun) =>
      `Done - your ${noun} is disconnected and Hale deleted its keys. Google still lists Hale until you remove it at myaccount.google.com/permissions`,
    not_connected: (noun) =>
      `Hale has no keys for your ${noun} - nothing to disconnect. Text connect my ${noun} if you want to link it.`,
    revoke_failed: () => failureReply(),
  },
  fr: {
    revoked: (noun) =>
      `Fait - votre ${noun} est déconnecté, Hale a supprimé ses clés. Google garde Hale jusqu'à ce que vous l'enleviez sur myaccount.google.com/permissions`,
    not_connected: (noun) =>
      `Hale n'a pas de clés pour votre ${noun} - rien à déconnecter. Textez connecter mon ${noun} pour le lier.`,
    revoke_failed: () => `Quelque chose s'est mal passé chez moi - rien n'a changé. Réessayez dans une minute.`,
  },
};

/** The whole disconnect reply, per outcome — one place, so the three ways this turn can
 * end cannot drift into three different tones. */
export function connectorRevokeReply(
  language: ReplyLanguage,
  provider: ConnectorProvider,
  outcome: ConnectorRevokeOutcome['status'],
): string {
  return REVOKE_BY_LANGUAGE[language][outcome](PROVIDER_NOUN[language][provider]);
}
