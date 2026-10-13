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

/**
 * Greyed, but still read (Design, 2026-10-12): the row is the only place the plan
 * status shows, so only its icon tile is muted. The words take the meta colour, which
 * clears WCAG AA (4.5:1) against the card and the page in both themes; a blanket
 * opacity on the row halved that.
 */
describe('the greyed row keeps its words readable', () => {
  const css = readFileSync(new URL('./portal.module.css', import.meta.url), 'utf8');

  function declarations(selector: string): Record<string, string> {
    const start = css.indexOf(`\n${selector} {`);
    if (start === -1) throw new Error(`portal.module.css has no rule for ${selector}`);
    const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
    return Object.fromEntries(
      body
        .split(';')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .map((line) => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
        }),
    );
  }

  function luminance(hex: string): number {
    const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
    const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  }

  function contrast(a: string, b: string): number {
    const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
  }

  it('mutes the icon tile only; the row itself carries no opacity', () => {
    expect(declarations('.rowOff')).toEqual({ cursor: 'default' });
    expect(declarations('.rowOff .tile')).toEqual({ opacity: '0.5' });
  });

  it('renders the title in the meta colour, like the line under it', () => {
    expect(declarations('.rowOff h3')).toEqual({ color: 'var(--meta)' });
    expect(declarations('.meta').color).toBe('var(--meta)');
  });

  it.each([
    ['light', '.shell'],
    ['dark', ':global(.dark) .shell'],
  ])('the meta colour clears 4.5:1 on the %s card and page', (_theme, selector) => {
    const tokens = declarations(selector);
    const meta = tokens['--meta'] ?? '';
    expect(meta).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(meta, tokens['--card'] ?? '')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(meta, tokens['--page'] ?? '')).toBeGreaterThanOrEqual(4.5);
  });

  it('positive control: the old half-opacity words would not have cleared it', () => {
    const tokens = declarations('.shell');
    const meta = tokens['--meta'] ?? '';
    const card = tokens['--card'] ?? '';
    const halfway = `#${[1, 3, 5]
      .map((at) =>
        Math.round(
          (Number.parseInt(meta.slice(at, at + 2), 16) + Number.parseInt(card.slice(at, at + 2), 16)) / 2,
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
    expect(contrast(halfway, card)).toBeLessThan(4.5);
  });
});
