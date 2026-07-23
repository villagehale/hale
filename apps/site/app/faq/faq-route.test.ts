import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FAQ } from '~/lib/faq/index.js';
import FaqPage from './page.js';

const html = renderToStaticMarkup(createElement(FaqPage));

describe('/faq — canonical product FAQ', () => {
  it('renders every product question once in the visible accordion', () => {
    for (const item of FAQ) {
      expect(html).toContain(item.question);
    }
  });

  it('keeps FAQPage structured data on the canonical route', () => {
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"FAQPage"');
  });

  it('uses accessible disclosure controls for every item', () => {
    expect(html.match(/aria-controls="faq-panel-/g)).toHaveLength(FAQ.length);
    expect(html.match(/aria-expanded="(?:true|false)" aria-controls="faq-panel-/g)).toHaveLength(
      FAQ.length,
    );
  });
});
