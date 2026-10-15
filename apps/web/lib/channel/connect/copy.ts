import {
  type CopyLanguage,
  type ReplyLanguage,
  copyFor,
  copyLanguage,
} from '~/lib/channel/language';
import { failureReply } from '~/lib/channel/router/copy';
import type { ConnectorProvider } from '~/lib/integrations/google-oauth';
import type { ConnectorRevokeOutcome } from './revoke';

/** What each connector is called to a parent, per language. 'Google Agenda' is the
 * product's own French name, not a translation choice. */
const PROVIDER_NOUN: Record<CopyLanguage, Record<ConnectorProvider, string>> = {
  en: { gcal: 'Google Calendar', gmail: 'Gmail', gdrive: 'Google Drive' },
  fr: { gcal: 'Google Agenda', gmail: 'Gmail', gdrive: 'Google Drive' },
};

/** A connector's name to a parent, as a fact for the model-written link text (#868:
 * the fixed single-provider offer is gone). */
export function connectorNoun(
  language: ReplyLanguage | null,
  provider: ConnectorProvider,
): string | null {
  const nouns = copyFor(PROVIDER_NOUN, language);
  return nouns ? nouns[provider] : null;
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
  CopyLanguage,
  Record<ConnectorRevokeOutcome['status'], (noun: string) => string>
> = {
  en: {
    revoked: (noun) =>
      `Done - your ${noun} is disconnected and Hale deleted its keys. Google still lists Hale until you remove it at myaccount.google.com/permissions`,
    not_connected: (noun) =>
      `Hale has no keys for your ${noun} - nothing to disconnect. Ask in this thread if you want to link it.`,
    revoke_failed: () => failureReply(),
  },
  fr: {
    revoked: (noun) =>
      `Fait - votre ${noun} est déconnecté, Hale a supprimé ses clés. Google garde Hale jusqu'à ce que vous l'enleviez sur myaccount.google.com/permissions`,
    not_connected: (noun) =>
      `Hale n'a pas de clés pour votre ${noun} - rien à déconnecter. Demandez dans ce fil si vous voulez le lier.`,
    revoke_failed: () =>
      `Quelque chose s'est mal passé chez moi - rien n'a changé. Réessayez dans une minute.`,
  },
};

/** The whole disconnect reply, per outcome — one place, so the three ways this turn can
 * end cannot drift into three different tones. */
export function connectorRevokeReply(
  language: ReplyLanguage | null,
  provider: ConnectorProvider,
  outcome: ConnectorRevokeOutcome['status'],
): string | null {
  const key = copyLanguage(language);
  const nouns = copyFor(PROVIDER_NOUN, language);
  const replies = copyFor(REVOKE_BY_LANGUAGE, language);
  if (!key || !nouns || !replies) return null;
  return replies[outcome](nouns[provider]);
}
