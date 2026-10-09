import type { ReplyLanguage } from '~/lib/channel/language';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';

/**
 * The vocabulary of the connect a parent does from the thread: which connectors a
 * texted link may name, what the button calls them, what the done page says, and what
 * Hale texts back. ONE module, because the page and the text land on the same phone ten
 * seconds apart — a promise written twice is a promise that will drift.
 *
 * GSM-7 throughout (scanned by sms-copy-encoding.test.ts): the receipts below go out
 * over the carrier. Page sentences live in connect-page-copy.ts so this file can
 * stay straight quotes.
 *
 * The TEXT receipts have a French twin (Sloane, 2026-09-24), chosen from the
 * family's primary language — the redirect itself carries no sentence. The done
 * page stays English: it is a browser tab, and the locked lines are the texts.
 */

/**
 * The connectors a texted deep link may name — the two Hale has a text-back path for
 * (integrations/calendar-alert.ts, integrations/email-alert.ts). Drive syncs but nothing
 * texts about it, so the receipt below would be a promise it cannot keep; a `to=gdrive`
 * link falls back to the destination the flow has always had.
 */
export const TEXT_CONNECT_PROVIDERS = [
  'gcal',
  'gmail',
] as const satisfies readonly ConnectorProvider[];

export type TextConnectProvider = (typeof TEXT_CONNECT_PROVIDERS)[number];

/** The allowlist, as a narrowing. Everything that reaches this flow off a query string —
 * the redeem page's `to`, the done page's `provider` — comes through here (rule #1: the
 * only providers that exist are the ones this module has words for). */
export function asTextConnectProvider(
  value: string | undefined | null,
): TextConnectProvider | null {
  return TEXT_CONNECT_PROVIDERS.find((provider) => provider === value) ?? null;
}

const PROVIDER_NOUN: Record<TextConnectProvider, string> = {
  gcal: 'Google Calendar',
  gmail: 'Gmail',
};

/**
 * The one trust line on a texted connect link. Same sentence for both connectors:
 * Hale never sees the password, and disconnecting is something the parent can
 * do. It is not a phrase to text back.
 */
export const CONNECTOR_TRUST_LINE: Record<TextConnectProvider, string> = {
  gcal: 'I never see your password. You can disconnect any time.',
  gmail: 'I never see your password. You can disconnect any time.',
};

/**
 * One plain line before a Google connect link. Google's unverified-app screen
 * is outside Hale's page; this is the only coaching for it. Straight quotes,
 * no emoji, GSM-7.
 */
export const GOOGLE_UNVERIFIED_APP_LINE_BY_LANGUAGE: Record<ReplyLanguage, string> = {
  en: 'Google may show an "unverified app" screen. Tap Advanced, then continue.',
  fr: 'Google peut afficher un ecran "application non verifiee". Touchez Avance, puis continuez.',
};

export function googleUnverifiedAppLine(language: ReplyLanguage): string {
  return GOOGLE_UNVERIFIED_APP_LINE_BY_LANGUAGE[language];
}

/** The coaching line, then the link sentence. Every Google connect link carries it once. */
export function withGoogleConnectCaution(language: ReplyLanguage, body: string): string {
  const line = googleUnverifiedAppLine(language);
  if (body.startsWith(line)) return body;
  return `${line}\n${body}`;
}

/** What the link unfurls as. Title is the ask. Description is the trust line. */
export const CONNECTOR_CARD_TITLE: Record<TextConnectProvider, string> = {
  gcal: 'Connect your calendar',
  gmail: 'Connect Gmail',
};

export interface ConnectorLinkCard {
  title: string;
  description: string;
}

/** Preview and page copy for one texted connect link. A link with no connector
 * has no card to promise. The token never enters this copy. */
export function connectorLinkCard(provider: TextConnectProvider | null): ConnectorLinkCard {
  if (provider === 'gmail') {
    return {
      title: CONNECTOR_CARD_TITLE.gmail,
      description: 'So Hale can flag daycare and school notices for you.',
    };
  }
  if (provider === 'gcal') {
    return {
      title: CONNECTOR_CARD_TITLE.gcal,
      description: 'So Hale can catch class invites and trip dates for the kids.',
    };
  }
  return {
    title: 'Connect',
    description: 'One tap signs you in and opens your connected apps.',
  };
}

/** The redeem button. It says what the next tap does, because the next thing the parent
 * sees is Google's consent screen and nothing else on this page explains it. */
export function textConnectButtonLabel(provider: TextConnectProvider): string {
  return `Connect ${PROVIDER_NOUN[provider]}`;
}

/**
 * The one text Hale sends once the tokens are stored — confirm what landed, then
 * one kids-year payoff. The trust line (password, disconnect) lives on the card
 * that asked for the tap, not again here.
 */
/**
 * Design locked (Sloane, 2026-09-24). The receipt is its own turn: no ask rides
 * with it. English is the default. French is the family's primary language.
 */
export const CONNECTOR_CONNECTED_TEXT_BY_LANGUAGE: Record<
  ReplyLanguage,
  Record<TextConnectProvider, string>
> = {
  en: {
    gcal: "Calendar's connected. I'll catch class invites and trip dates.",
    gmail: "Gmail's connected. I'll flag daycare and school notices.",
  },
  fr: {
    gcal: 'Calendrier connecte. Je note les invitations de cours et les dates de voyage.',
    gmail: "Gmail connecte. Je flaggue les avis de garderie et d'ecole.",
  },
};

/** English receipts. Callers that already hold a language use the map above. */
export const CONNECTOR_CONNECTED_TEXT: Record<TextConnectProvider, string> =
  CONNECTOR_CONNECTED_TEXT_BY_LANGUAGE.en;

export function connectorConnectedText(
  language: ReplyLanguage,
  provider: TextConnectProvider,
): string {
  return CONNECTOR_CONNECTED_TEXT_BY_LANGUAGE[language][provider];
}
