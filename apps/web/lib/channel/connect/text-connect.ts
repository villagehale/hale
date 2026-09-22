import type { ConnectorProvider } from '~/lib/integrations/google-oauth';

/**
 * The vocabulary of the connect a parent does from the thread: which connectors a
 * texted link may name, what the button calls them, what the done page says, and what
 * Hale texts back. ONE module, because the page and the text land on the same phone ten
 * seconds apart — a promise written twice is a promise that will drift.
 *
 * GSM-7 throughout (scanned by sms-copy-encoding.test.ts): the receipts below go out
 * over the carrier, and the page copy shares their clauses.
 *
 * ENGLISH ONLY, deliberately. `ReplyLanguage` is derived per message and never stored
 * (channel/language.ts), and the callback runs on a redirect from Google that carries
 * nothing the parent typed — so there is no language here to answer in, and an FR twin
 * nothing could select would be words no parent can reach.
 */

/**
 * The connectors a texted deep link may name — the two Hale has a text-back path for
 * (integrations/calendar-alert.ts, integrations/email-alert.ts). Drive syncs but nothing
 * texts about it, so the receipt below would be a promise it cannot keep; a `to=gdrive`
 * link falls back to the destination the flow has always had.
 */
export const TEXT_CONNECT_PROVIDERS = ['gcal', 'gmail'] as const satisfies readonly ConnectorProvider[];

export type TextConnectProvider = (typeof TEXT_CONNECT_PROVIDERS)[number];

/** The allowlist, as a narrowing. Everything that reaches this flow off a query string —
 * the redeem page's `to`, the done page's `provider` — comes through here (rule #1: the
 * only providers that exist are the ones this module has words for). */
export function asTextConnectProvider(value: string | undefined | null): TextConnectProvider | null {
  return TEXT_CONNECT_PROVIDERS.find((provider) => provider === value) ?? null;
}

const PROVIDER_NOUN: Record<TextConnectProvider, string> = {
  gcal: 'Google Calendar',
  gmail: 'Gmail',
};

/**
 * What the connection is for, said once so the page and the text cannot disagree.
 *
 * A kids-year payoff, not a life-assistant watch. Calendar keeps what is on for
 * the kids and when it moves. Gmail lets daycare and school notices into that
 * year. Neither promises to text about whatever else lands.
 */
const YEAR_PAYOFF: Record<TextConnectProvider, string> = {
  gcal: "what's on for the kids, and when it moves, stays in the year",
  gmail: 'daycare and school notices get into the year',
};

function payoffSentence(clause: string): string {
  return `${clause.charAt(0).toUpperCase()}${clause.slice(1)}`;
}

/**
 * The one trust line on a connect card. Same shape for both connectors: Hale
 * never sees the password, and the disconnect words are ones the text parser
 * actually honours. The noun matches the card so "disconnect anytime" is a
 * command, not a slogan.
 */
export const CONNECTOR_TRUST_LINE: Record<TextConnectProvider, string> = {
  gcal: 'I never see your password. Disconnect my calendar anytime.',
  gmail: 'I never see your password. Disconnect my gmail anytime.',
};

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
  if (!provider) {
    return {
      title: 'Connect - Hale',
      description: 'I never see your password. Disconnect anytime.',
    };
  }
  return {
    title: CONNECTOR_CARD_TITLE[provider],
    description: CONNECTOR_TRUST_LINE[provider],
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
export const CONNECTOR_CONNECTED_TEXT: Record<TextConnectProvider, string> = {
  gcal: `Your ${PROVIDER_NOUN.gcal} is connected. ${payoffSentence(YEAR_PAYOFF.gcal)}.`,
  gmail: `${PROVIDER_NOUN.gmail} is connected. ${payoffSentence(YEAR_PAYOFF.gmail)}.`,
};

/** What the done page says, per outcome. The heading is the state in two words; the body
 * is the whole sentence, so a parent reading only one of them still knows where they are. */
export interface ConnectedNotice {
  heading: string;
  body: string;
}

/**
 * The done page's words for a (status, provider) pair straight off the query string.
 *
 * FAIL CLOSED on anything it does not recognise, including `status=ok` for a provider
 * with no words: a page that congratulated a parent on a connection nobody can name
 * would be the one lie this flow cannot afford. Every failure hands back the same thing
 * — a text to send — because the thread is where this flow lives.
 */
export function connectedNotice(
  status: string | undefined,
  provider: string | undefined,
): ConnectedNotice {
  const connected = asTextConnectProvider(provider);
  if (status === 'ok' && connected) {
    return {
      heading: 'Connected',
      body: `${PROVIDER_NOUN[connected]} is connected. You can close this - ${YEAR_PAYOFF[connected]}.`,
    };
  }
  if (status === 'denied') {
    return {
      heading: 'Nothing changed',
      body: "No changes made. Text me 'connect my calendar' if you change your mind.",
    };
  }
  if (status === 'invalid') {
    return {
      heading: 'Link expired',
      body: "That link has expired. Text me 'connect my calendar' for a fresh one.",
    };
  }
  return {
    heading: 'Not connected',
    body: "That didn't go through. Text me 'connect my calendar' and I'll send a fresh link.",
  };
}
