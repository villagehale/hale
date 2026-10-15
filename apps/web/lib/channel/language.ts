/**
 * A language Hale may store and hand to a model.
 *
 * The tag is the model's, or a value already stored for the family. A sentence is
 * not a tag: code does not classify the words in front of it. The parent's own
 * words decide the reply; `certainLanguageHint` only forwards a tag that was
 * already accepted.
 */

/** A BCP-47 language tag (`en`, `fr`, `zh`, `ar`, `fr-ca`). */
export type ReplyLanguage = string;

/** The two languages that still have a fixed template. Anything else is the model's. */
export type CopyLanguage = 'en' | 'fr';

const TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

/** A stored tag, or null. Free text, including a sentence, is not a tag. */
export function acceptReplyLanguage(value: string | null | undefined): ReplyLanguage | null {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase();
  return TAG.test(tag) ? tag : null;
}

/**
 * The same check as {@link acceptReplyLanguage}. Kept under the old name so a
 * stored column (`en`, `fr`, `zh`) still round-trips, and a message body does not.
 */
export function replyLanguage(value: string | null | undefined): ReplyLanguage | null {
  return acceptReplyLanguage(value);
}

/** What a model is told. Any stored tag, including `zh` and `ar`. A sentence is not a hint. */
export function certainLanguageHint(
  language: ReplyLanguage | null | undefined,
): ReplyLanguage | null {
  return acceptReplyLanguage(language);
}

/** `en` or `fr` when the tag is one of those, including `en-ca` and `fr-ca`. Otherwise null. */
export function copyLanguage(language: ReplyLanguage | null | undefined): CopyLanguage | null {
  const tag = acceptReplyLanguage(language);
  if (!tag) return null;
  if (tag === 'fr' || tag.startsWith('fr-')) return 'fr';
  if (tag === 'en' || tag.startsWith('en-')) return 'en';
  return null;
}

/** The template for this tag, or null when the tag is not English or French. */
export function copyFor<T>(
  table: Record<CopyLanguage, T>,
  language: ReplyLanguage | null | undefined,
): T | null {
  const key = copyLanguage(language);
  return key ? table[key] : null;
}

/**
 * An Intl locale for a stored tag. A bare `en` or `fr` keeps the Canadian
 * default those tags have always used. Any other tag is handed to Intl as-is.
 * A missing tag formats dates as `en-CA` for the model fact sheet only.
 */
export function localeFor(language: ReplyLanguage | null | undefined): string {
  const tag = acceptReplyLanguage(language);
  if (!tag || tag === 'en') return 'en-CA';
  if (tag === 'fr') return 'fr-CA';
  return tag;
}
