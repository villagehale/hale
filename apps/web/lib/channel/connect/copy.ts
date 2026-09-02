import type { ReplyLanguage } from '~/lib/channel/language';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';

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
