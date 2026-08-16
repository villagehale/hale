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

  /**
   * Every answer is openable from the server-rendered markup alone. The React
   * accordion this replaced held the open index in useState, so with its
   * JavaScript unarrived exactly one item was readable and the other six could
   * not be opened at all — on the page whose whole job is answering the question
   * a parent came with. A native <details> has no such state.
   */
  it('gives every item a native disclosure that opens without JavaScript', () => {
    expect(html.match(/<details/g)).toHaveLength(FAQ.length);
    expect(html.match(/<summary/g)).toHaveLength(FAQ.length);
    // Exactly one is open on arrival — the group is exclusive through the shared
    // `name`, which is the browser's own accordion rather than a state variable.
    expect(html.match(/<details[^>]*\bopen\b/g)).toHaveLength(1);
    expect(html.match(/name="product-faq"/g)).toHaveLength(FAQ.length);
  });

  it('renders every answer’s text, open or closed', () => {
    // The closed items are collapsed by the UA, not withheld: a reader can find
    // any answer with find-in-page or a print, and a crawler sees all seven.
    for (const item of FAQ) {
      expect(html).toContain(item.answer);
    }
  });
});
