import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';
// Type-only: voice/said-line.ts imports connectorNoun from here at runtime.
import type { SaidLineInput, SaidLineWriter } from '~/lib/channel/voice/said-line';
import type { GoogleAccessOutcome } from '~/lib/integrations/google-disconnect';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';
import type { ConnectorRevokeOutcome } from './revoke';

/** A connector's name to a parent, written with the rest of the line. */
export function connectorNoun(
  language: ReplyLanguage | null,
  provider: ConnectorProvider,
): Promise<string | null> {
  return speak({ purpose: 'connector_noun', language, facts: { provider } });
}

/** Google's own product names: proper nouns, handed to the writer as data. */
const PRODUCT_NAME: Record<ConnectorProvider, string> = {
  gcal: 'Google Calendar',
  gmail: 'Gmail',
  gdrive: 'Google Drive',
};

/**
 * What Hale may say about Google's side, one fact per outcome (VIL-156). Each claims
 * exactly what Google answered: never "Google removed access" on an unanswered or
 * unconfirmed revoke.
 */
const GOOGLE_ACCESS_FACT: Record<GoogleAccessOutcome, string> = {
  revoked: "Google has removed Hale's access to their Google account",
  pending_retry:
    'Hale asked Google to remove its access; Google has not confirmed yet, and Hale keeps asking',
  not_confirmed:
    "Hale deleted its keys, but Google did not confirm that it removed Hale's access, and Hale cannot ask again; their Google account settings show whether Hale is still listed",
};

function revokeFacts(outcome: ConnectorRevokeOutcome): Pick<SaidLineInput, 'facts' | 'mustConvey'> {
  switch (outcome.status) {
    case 'revoked':
      return {
        facts: {
          turnedOff: outcome.providers.map((provider) => PRODUCT_NAME[provider]),
          // Google revokes per project, so both are off whichever one they named.
          bothOff: "Hale can no longer read this parent's Gmail or Google Calendar",
          googleAccess: GOOGLE_ACCESS_FACT[outcome.google],
          reconnect: 'they can ask Hale here to connect either service again',
        },
        mustConvey: ['bothOff', 'googleAccess'],
      };
    case 'not_connected':
      return {
        facts: { outcome: 'nothing of theirs was connected to that service, so nothing changed' },
      };
    case 'revoke_failed':
      return {
        facts: {
          outcome: 'the disconnect did not go through and nothing changed; asking again retries it',
        },
      };
  }
}

/** The writer's whole request for a disconnect reply. The said-line eval replays it. */
export function connectorRevokeLineInput(input: {
  language: ReplyLanguage | null;
  parentWords: string;
  outcome: ConnectorRevokeOutcome;
}): SaidLineInput {
  return {
    purpose: 'connector_revoke',
    language: input.language,
    parentWords: input.parentWords,
    ...revokeFacts(input.outcome),
  };
}

/**
 * THE DISCONNECT REPLY, written by the model from facts (no fixed copy). No link and no
 * token reach the writer: the way back is to ask, and the connect handler mints the link
 * in the right thread when they do. Null: the caller sends nothing and logs why.
 */
export function writeConnectorRevokeReply(
  writer: SaidLineWriter,
  input: { language: ReplyLanguage | null; parentWords: string; outcome: ConnectorRevokeOutcome },
): Promise<string | null> {
  return writer.write(connectorRevokeLineInput(input));
}
