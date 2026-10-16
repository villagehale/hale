import type { ReplyLanguage } from '~/lib/channel/language';
import { speak } from '~/lib/channel/spoken-line';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';
import type { ConnectorRevokeOutcome } from './revoke';

/** A connector's name to a parent, written with the rest of the line. */
export function connectorNoun(
  language: ReplyLanguage | null,
  provider: ConnectorProvider,
): Promise<string | null> {
  return speak({ purpose: 'connector_noun', language, facts: { provider } });
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
const REMOVAL_URL = 'myaccount.google.com/permissions';

/** The whole disconnect reply. The removal URL, when this outcome names it, is verbatim. */
export async function connectorRevokeReply(
  language: ReplyLanguage | null,
  provider: ConnectorProvider,
  outcome: ConnectorRevokeOutcome['status'],
): Promise<string | null> {
  const noun = await connectorNoun(language, provider);
  if (!noun) return null;
  return speak({
    purpose: 'connector_revoke',
    language,
    facts: { noun, outcome, provider },
    verbatim: outcome === 'revoked' ? [REMOVAL_URL, noun] : [noun],
  });
}
