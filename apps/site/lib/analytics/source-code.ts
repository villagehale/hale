import { parseSourceCode } from '~/lib/text-entry';

/**
 * FIRST-TOUCH ACQUISITION ATTRIBUTION for the marketing site.
 *
 * The `?s=` tag started on the /text QR cards (lib/text-entry.ts owns its shape and its
 * validator). It is now the site-wide question: which card, poster, or forwarded
 * referral link produced the visit that produced the text. That question is only
 * answerable if the tag survives the hop from the tagged landing to the page the CTA is
 * finally tapped on, which is what this module is for.
 *
 * FIRST TOUCH WINS. A parent who lands on `/?s=earlyon-richmondhill`, reads /faq, and
 * texts from the header is attributed to the EarlyON card — the thing that actually
 * earned the visit — not to the last URL they happened to be on. A later `?s=` in the
 * same session is therefore ignored rather than overwriting it.
 *
 * sessionStorage, deliberately, and it is the reason this file exists at all:
 *   · Not a cookie. First-touch attribution is sessionStorage (or URL-only). Google
 *     Ads may set its own advertising cookies on this origin for landing-page
 *     measurement (lib/analytics/google-ads.ts); that is a different layer and is
 *     not how a visit is credited to a card.
 *   · Not localStorage. Attribution is a fact about ONE visit. A value that outlived the
 *     tab would credit a card seen in March for a text sent in August.
 *
 * Nothing unvalidated is stored or sent: the value is a `<channel>-<place>` kebab code
 * or it does not exist (hard rule #1 — this string reaches an analytics property).
 */

/** The query parameter every entry surface tags its links with. */
export const SOURCE_CODE_PARAM = 's';

/**
 * Poster QR URLs carry `?src=<poster-slug>&utm_source=poster&utm_medium=qr&utm_campaign=…`
 * (docs/launch-runbook.md). Read in order: `s` (the original /text card tag), then `src`,
 * then — ONLY on a poster link (`utm_source=poster`) — `utm_campaign` as the fallback.
 * An ad's `utm_campaign` is not a card and must not become one. Every candidate passes
 * the same validator.
 */
export const SOURCE_CODE_PARAMS = [SOURCE_CODE_PARAM, 'src'] as const;

/** The first VALID code from the URL, or null. Exported for tests. */
export function sourceCodeFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  for (const name of SOURCE_CODE_PARAMS) {
    const code = parseSourceCode(params.get(name) ?? undefined);
    if (code) return code;
  }
  if (params.get('utm_source') === 'poster') {
    return parseSourceCode(params.get('utm_campaign') ?? undefined);
  }
  return null;
}

/** Where the first touch is held for the rest of the tab session. */
export const SOURCE_CODE_STORAGE_KEY = 'hale.first_touch_source';

/** The slice of `sessionStorage` this needs — injected so the rule is unit-tested. */
export type SessionLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The source code to attribute this pageview to, remembering the first one seen.
 *
 * `storage` may be null: Safari's private mode and a locked-down browser both make
 * `sessionStorage` throw on access. That degrades to URL-only attribution — the tagged
 * page still reports its own code — rather than failing the pageview.
 */
export function readFirstTouchSourceCode(
  search: string,
  storage: SessionLike | null,
): string | null {
  const fromUrl = sourceCodeFromSearch(search);
  if (!storage) return fromUrl;

  // Re-validated on the way out, not trusted because we wrote it: sessionStorage is a
  // key any script on the origin can set, and this value becomes an analytics property.
  const remembered = parseSourceCode(storage.getItem(SOURCE_CODE_STORAGE_KEY) ?? undefined);
  if (remembered) return remembered;
  if (fromUrl) storage.setItem(SOURCE_CODE_STORAGE_KEY, fromUrl);
  return fromUrl;
}
