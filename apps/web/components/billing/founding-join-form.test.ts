import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FoundingJoinForm } from './founding-join-form';
import { FreeJoinCard } from './free-join-card';

describe('FoundingJoinForm', () => {
  it('shows Plus and Max yearly prices with a plain $ and a full refund anytime', () => {
    const html = renderToStaticMarkup(
      createElement(FoundingJoinForm, { plusLabel: '$59/yr', maxLabel: '$99/yr' }),
    );
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
    expect(html).toContain('Plus');
    expect(html).toContain('Max');
    expect(html).toContain('Full refund anytime');
    expect(html).not.toContain('C$');
    expect(html).not.toMatch(/\bCAD\b/);
    expect(html).not.toContain('ask for a refund');
  });
});

describe('FreeJoinCard', () => {
  it('keeps the free promise next to founding join', () => {
    const html = renderToStaticMarkup(createElement(FreeJoinCard));
    expect(html).toContain('Free');
    expect(html).toContain('Everything Hale does is free for you.');
    expect(html).not.toMatch(/\$\d/);
  });
});

describe('/founding three-option pair', () => {
  it('renders Free plus Plus and Max annual, with no monthly or list annual', () => {
    const html = renderToStaticMarkup(
      createElement('div', null, [
        createElement(FreeJoinCard, { key: 'free' }),
        createElement(FoundingJoinForm, {
          key: 'founding',
          plusLabel: '$59/yr',
          maxLabel: '$99/yr',
        }),
      ]),
    );
    expect(html).toContain('Free');
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
    expect(html).toContain('Join as a founding family');
    expect(html).not.toContain('/mo');
    expect(html).not.toContain('$159/yr');
    expect(html).not.toContain('Continue ·');
  });
});
