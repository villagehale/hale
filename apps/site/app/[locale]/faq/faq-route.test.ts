import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FAQ } from '~/lib/faq/index.js';
import FaqPage from './page.js';

const html = renderToStaticMarkup(await FaqPage({ params: Promise.resolve({ locale: 'en' as const }) }));

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

  /**
   * Every answer is openable from the server-rendered markup alone. The React
   * accordion this replaced held the open index in useState, so with its
   * JavaScript unarrived exactly one item was readable and the other six could
   * not be opened at all — on the page whose whole job is answering the question
   * a parent came with. A native <details> has no such state.
   */
  it('prints every question in the server HTML, so it is readable with JavaScript off', () => {
    // The redesign answers are open in the markup. A closed <details> accordion
    // is gone: a reader, a crawler, and find-in-page all see the full list.
    for (const item of FAQ) {
      expect(html).toContain(item.question);
    }
    expect(html).not.toContain('<details');
  });

  it('renders every answer’s text, open or closed', () => {
    // The closed items are collapsed by the UA, not withheld: a reader can find
    // any answer with find-in-page or a print, and a crawler sees all seven.
    for (const item of FAQ) {
      expect(html).toContain(item.answer);
    }
  });
});
