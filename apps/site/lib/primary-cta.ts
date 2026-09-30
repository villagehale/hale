import { SOURCE_CODE_PARAM } from '~/lib/analytics/source-code';
import type { Platform } from '~/lib/chooser';
import { buildSmsBody, buildSmsHrefForBody, smsUriFormForPlatform } from '~/lib/text-entry';

/**
 * Where the site's primary "Text Hale" doors go (header, hero, closing).
 *
 * A phone opens the messaging app with the locked prefill — iOS `sms:&body=`,
 * Android `sms:?body=`. Every desktop, including macOS, keeps the existing
 * /text page: that page already shows the QR and the number, and an `sms:`
 * link is a dead click on Windows and Linux. No number provisioned is the
 * same door — the caller degrades to email before it gets here, and a missing
 * number must not become a broken `sms:` href.
 */
export function primaryTextTarget(input: {
  platform: Platform;
  smsNumber: string;
  prefill: string;
  source: string | null;
  /** Locale-prefixed path of the /text page, e.g. `/text` or `/fr/text`. */
  textPath: string;
}): { href: string; composer: boolean } {
  const phone = input.platform === 'apple' || input.platform === 'android';
  if (!phone || input.smsNumber === '') {
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
