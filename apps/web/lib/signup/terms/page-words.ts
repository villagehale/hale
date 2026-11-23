import { withoutLinks } from '~/lib/format/link-shape';

/** The longest quote the page read keeps. */
export const MAX_PAGE_QUOTE_CHARS = 400;
/** Room for a level and a course name, and little else a page might try to say. */
export const MAX_PREREQUISITE_QUOTE_CHARS = 200;

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
