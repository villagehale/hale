import type { Route } from 'next';
import { threadOnboardingV2Enabled } from '~/lib/channel/intake/thread-onboarding-v2';
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
 * link lands on the family page like any other target this module does not name.
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

/**
 * The app pages a texted sign-in link may name, beside the connectors. A link goes
 * where it was minted to go; one that names nothing here lands on the family page.
 * `to` is a closed, machine-minted value on Hale's own URL, never parent text.
 */
export const TEXT_LINK_PAGES = ['privacy'] as const;

export type TextLinkPage = (typeof TEXT_LINK_PAGES)[number];

/**
 * VIL-721. The one link that connects Gmail and the calendar together, in one Google
 * consent asking for both read scopes. A link target, never a connector: each grant it
 * yields is stored as the connector it is (gmail, gcal), and every receipt and fresh
 * link names the bundle by this word.
 */
export const GOOGLE_BUNDLE_LINK = 'google' as const;

export type GoogleBundleLink = typeof GOOGLE_BUNDLE_LINK;

/** The connectors one bundle link asks Google for, in the order the consent lists them. */
export const GOOGLE_BUNDLE_PROVIDERS = [
  'gmail',
  'gcal',
] as const satisfies readonly TextConnectProvider[];

/**
 * Exact match, and only while THREAD_ONBOARDING_V2_ENABLED is on. Dark, `to=google`
 * names nothing this deployment mints, so it lands like any unknown target (the
 * family page), and no Google consent starts from it.
 */
export function asGoogleBundleLink(value: string | undefined | null): GoogleBundleLink | null {
  return value === GOOGLE_BUNDLE_LINK && threadOnboardingV2Enabled() ? GOOGLE_BUNDLE_LINK : null;
}

export type TextLinkTarget = TextConnectProvider | TextLinkPage | GoogleBundleLink;

export const TEXT_LINK_PAGE_PATH: Record<TextLinkPage, Route> = { privacy: '/privacy' };

export const TEXT_LINK_DEFAULT_PATH: Route = '/family';

/** The whole link allowlist, as an exact-match narrowing (same contract as
 * asTextConnectProvider). */
export function asTextLinkTarget(value: string | undefined | null): TextLinkTarget | null {
  return asTextConnectProvider(value) ?? asTextLinkPage(value) ?? asGoogleBundleLink(value);
}

export function asTextLinkPage(value: string | undefined | null): TextLinkPage | null {
  return TEXT_LINK_PAGES.find((page) => page === value) ?? null;
}

const PROVIDER_NOUN: Record<TextConnectProvider, string> = {
  gcal: 'Google Calendar',
  gmail: 'Gmail',
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
