import { SOURCE_CODE_PARAM } from '~/lib/analytics/source-code';
import { type Platform, messagesCapable } from '~/lib/chooser';
import { buildSmsBody, buildSmsHrefForBody, smsUriFormForPlatform } from '~/lib/text-entry';

/**
 * Where the site's primary "Text Hale" doors go (header, hero, closing, and
 * every other door that says Text Hale).
 *
 * iPhone, iPad, Mac, and Android open the messaging app with the locked
 * prefill — Apple `sms:&body=`, Android `sms:?body=`. The body is
 * {@link buildSmsBody}, so a `?s=` code still rides as `(via <code>)`.
 * Windows, Linux, and an unknown client stay on /text (carrying `?s=` when
 * there is one): an `sms:` link is a dead click there, and that page already
 * shows the QR and the number. No number provisioned is the same door — the
 * caller degrades to email before it gets here, and a missing number must not
 * become a broken `sms:` href.
 *
 * Server render passes `unknown`, so the HTML (no-JS, and the first paint) is
 * always the /text link. The client upgrades to `sms:` only after it has read
 * the user agent.
 */
export function primaryTextTarget(input: {
  platform: Platform;
  smsNumber: string;
  prefill: string;
  source: string | null;
  /** Locale-prefixed path of the /text page, e.g. `/text` or `/fr/text`. */
  textPath: string;
}): { href: string; composer: boolean } {
  if (!messagesCapable(input.platform) || input.smsNumber === '') {
    const href = input.source
      ? `${input.textPath}?${SOURCE_CODE_PARAM}=${input.source}`
      : input.textPath;
    return { href, composer: false };
  }
  return {
    href: buildSmsHrefForBody(
      input.smsNumber,
      buildSmsBody(input.source, input.prefill),
      smsUriFormForPlatform(input.platform),
    ),
    composer: true,
  };
}
