import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DESIGN_FAQ_GROUPS } from '~/components/landing/oct-2026/faq.js';
import FaqPage from './page.js';

const html = renderToStaticMarkup(
  await FaqPage({ params: Promise.resolve({ locale: 'en' as const }) }),
);
describe('/faq — supplied grouped FAQ', () => {
  it('shows every answer without requiring JavaScript or opening a disclosure', () => {
    for (const group of DESIGN_FAQ_GROUPS) {
      expect(html).toContain(`href="#${group.id}"`);
      expect(html).toContain(`id="${group.id}"`);
      for (const item of group.items) {
        expect(html).toContain(item.question);
        expect(html).toContain(item.answer.replaceAll('&', '&amp;'));
      }
    }
  });
  it('emits structured data from the same visible FAQ data', () => {
    const schema = JSON.parse(
      html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '{}',
    );
    expect(schema['@type']).toBe('FAQPage');
    expect(schema.mainEntity.map((item: { name: string }) => item.name)).toEqual(
      DESIGN_FAQ_GROUPS.flatMap((group) => group.items.map((item) => item.question)),
    );
  });
});
