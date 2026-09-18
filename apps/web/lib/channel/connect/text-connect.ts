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

/** What Hale will do with the connection, said once so the page and the text cannot
 * disagree about what a parent just agreed to. */
const WATCH_PROMISE: Record<TextConnectProvider, string> = {
  gcal: "I'll text you when something new lands on it",
  gmail: "I'll text you when a daycare or school email needs you",
};

/** The redeem button. It says what the next tap does, because the next thing the parent
 * sees is Google's consent screen and nothing else on this page explains it. */
export function textConnectButtonLabel(provider: TextConnectProvider): string {
  return `Connect ${PROVIDER_NOUN[provider]}`;
}

/**
 * The one text Hale sends once the tokens are stored — the receipt for something the
 * parent did ten seconds ago, in the thread they did it from.
 *
 * Each names the way out in the same breath as the way in: a connection a parent cannot
 * remember how to undo is one they will resent (rule #1, natural-language consent).
 */
export const CONNECTOR_CONNECTED_TEXT: Record<TextConnectProvider, string> = {
  gcal: `Your ${PROVIDER_NOUN.gcal} is connected. ${WATCH_PROMISE.gcal} - and you can say disconnect my calendar anytime.`,
  gmail: `${PROVIDER_NOUN.gmail} is connected. ${WATCH_PROMISE.gmail}. Nothing else.`,
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
      body: `${PROVIDER_NOUN[connected]} is connected. You can close this - ${WATCH_PROMISE[connected]}.`,
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
