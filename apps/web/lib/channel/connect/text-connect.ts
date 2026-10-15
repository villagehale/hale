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
 * A FACT, NOT COPY: structured, so there is no sentence to paste. Google's unverified-app screen is outside Hale's page, so a parent
 * about to open a Google connect link is told about it - by the line writer, in its own
 * words and the parent's language. Nothing appends or prepends this text to a message.
 */
export const GOOGLE_UNVERIFIED_APP_FACT = {
  screen: 'unverified app',
  shownBy: 'Google',
  wayPast: ['Advanced', 'continue'],
} as const;

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
