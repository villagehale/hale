import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { routing } from '~/i18n/routing.js';
import ContactPage from './page.js';

/**
 * The contact cards pair a translated channel with an inbox, and the pairing used
 * to be positional: `CHANNEL_EMAILS[i] ?? CHANNEL_EMAILS[0]`, zipped against
 * `t.raw('channels')`. A locale that reordered its two channels — or added a
 * third — silently labelled the privacy-request card with the general inbox, and
 * nothing anywhere would have said so. The copy is now keyed by channel id, and
 * this is the gate: in every locale the privacy card carries privacy@, in the
 * reader's own words.
 */

const PRIVACY_WORDS: Record<string, string> = {
  en: 'Privacy &amp; your data',
  fr: 'Confidentialité et vos données',
  zh: '隐私与你的数据',
};

async function render(locale: (typeof routing.locales)[number]): Promise<string> {
  return renderToStaticMarkup(await ContactPage({ params: Promise.resolve({ locale }) }));
}

/** The card wrapping a given eyebrow, so an assertion is about ONE card. */
function cardWith(html: string, eyebrow: string): string {
  const cards = html.split('<div class="glass-panel flex flex-col gap-4 p-6 sm:p-7">');
  const found = cards.find((card) => card.includes(eyebrow));
  if (!found) throw new Error(`no contact card carries "${eyebrow}"`);
  return found;
}

describe('/contact — each channel keeps its own inbox', () => {
  it.each(routing.locales)('pairs the privacy card with privacy@ in %s', async (locale) => {
    const html = await render(locale);
    const words = PRIVACY_WORDS[locale];
    if (!words) throw new Error(`no privacy eyebrow known for ${locale}`);
    const privacyCard = cardWith(html, words);
    expect(privacyCard).toContain('mailto:privacy@villagehale.com');
    expect(privacyCard).not.toContain('mailto:aloha@villagehale.com');
    // Positive control: the general card exists in the same render and carries
    // the OTHER inbox, so this passes because the pairing is right rather than
    // because the page rendered one card or none.
    expect(html).toContain('mailto:aloha@villagehale.com');
  });
});
