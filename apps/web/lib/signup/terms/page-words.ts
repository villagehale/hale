import { withoutLinks } from '~/lib/format/link-shape';
import { SITE_CHOICE_LABEL_MAX_CHARS, type SiteChoice } from '../site-choices';

/** The longest quote the page read keeps. */
export const MAX_PAGE_QUOTE_CHARS = 400;
/** Room for a level and a course name, and little else a page might try to say. */
export const MAX_PREREQUISITE_QUOTE_CHARS = 200;
/** Says how a model treats `untrusted_` keys, on the texts whose own skill does not. */
export const SIGNUP_PAGE_WORDS_SKILL = 'signup-page-words';

/**
 * Words a web page wrote, as a model may see them. Control and invisible characters go (an
 * invisible one could hide a host from the link strip), every link-shaped word goes, and
 * they are cut to `maxChars`. They still reach the model only under an `untrusted_` key.
 */
export function untrustedPageWords(raw: string | null, maxChars: number): string | null {
  if (raw === null) return null;
  const visible = raw
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ');
  const text = withoutLinks(visible).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return [...text].slice(0, maxChars).join('').trim();
}

/** A site's option as a model sees it. Its id and contact address are not page words it needs. */
export function markedSiteChoice(choice: SiteChoice) {
  return {
    price_cents: choice.price_cents,
    waitlist: choice.waitlist,
    untrusted_label: untrustedPageWords(choice.label, SITE_CHOICE_LABEL_MAX_CHARS),
    untrusted_starts_at: untrustedPageWords(choice.starts_at, SITE_CHOICE_LABEL_MAX_CHARS),
    untrusted_billing_note: untrustedPageWords(choice.billing_note, MAX_PAGE_QUOTE_CHARS),
  };
}
