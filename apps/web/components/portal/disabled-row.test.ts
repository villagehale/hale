import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DisabledRow } from './disabled-row';

/**
 * The Plan row on /settings and /home is greyed out and inert (VIL-131): it renders
 * the row's existing words, is announced as disabled, and is neither a link nor a
 * tab stop. /settings/plan stays reachable by URL; nothing on these pages links it.
 */

const ROW = { icon: createElement('svg'), title: 'Row title', meta: 'Row meta' };

describe('DisabledRow', () => {
  const markup = renderToStaticMarkup(createElement(DisabledRow, ROW));

  it('renders the words it is given and nothing it is not', () => {
    expect(markup).toContain('<h3>Row title</h3>');
    expect(markup).toContain('Row meta');
  });

  it('is announced as disabled and cannot be followed, focused or opened', () => {
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toContain('<a');
    expect(markup).not.toContain('href');
    expect(markup).not.toContain('tabindex');
    expect(markup).not.toContain('chevron');
  });
});

describe.each(['settings-index.tsx', 'home-view.tsx'])('%s Plan row', (file) => {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

  it('is a DisabledRow, and nothing links /settings/plan', () => {
    expect(source).toContain('<DisabledRow');
    expect(source).not.toContain('href="/settings/plan"');
  });

  it('positive control: the other settings rows still link', () => {
    expect(source).toContain('href="/settings/privacy"');
  });
});
