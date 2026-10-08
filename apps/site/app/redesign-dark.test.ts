import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Dark mode for the redesign lives on `.rd`, after redesign.css. The OS path
 * and the explicit data-theme path share one token set. Palette tokens stay
 * off the globals media-query walk (theme.test.ts).
 */

function css(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
}

function hex(value: string): [number, number, number] {
  const s = value.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(value: string): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hex(value);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

const PAGE = '#0c1a36';
const CARD = '#17294a';
const INK = '#f7f4ec';
const BODY = '#b7c4dc';
const META = '#9eadc9';
const AMBER = '#e2a75a';
const FOCUS = '#9fd0ea';

describe('redesign dark theme', () => {
  const dark = css('redesign-dark.css');

  it('scopes the night tokens to .rd, for an explicit choice and for the OS', () => {
    expect(dark).toContain(`:root[data-theme="dark"] .rd, :root.dark .rd { --page: ${PAGE};`);
    expect(dark).toContain(`:root:not([data-theme="light"]):not(.light) .rd { --page: ${PAGE};`);
    expect(dark).toContain(`--band: #101f3f; --card: ${CARD};`);
    expect(dark).toContain(`--navy: ${INK}; --cream: ${PAGE}; --amber: ${AMBER};`);
    expect(dark).toContain('--amber-tint: rgb(226 167 90 / 0.10);');
    expect(dark).toContain('--amber-ring: rgb(226 167 90 / 0.55);');
    expect(dark).toContain(`--slate: ${BODY}; --meta: ${META};`);
    expect(dark).toContain(`--focus: ${FOCUS};`);
    expect(dark).toContain('--ios-bg: #000000;');
    expect(dark).toContain('--ios-in: #262628;');
    expect(dark).toContain('--ios-out: #0a84ff;');
    expect(dark).not.toMatch(/\.rd \.rd/);
  });

  it('nights the shore, the tiers and the logo ring', () => {
    expect(dark).toContain('filter: saturate(0.8) brightness(0.72) hue-rotate(-8deg);');
    expect(dark).toContain('.shore-drift.sky { opacity: 0.22; }');
    expect(dark).toContain('.shore-drift.sea { opacity: 0.14; }');
    expect(dark).toContain(
      '.t-free { background: linear-gradient(180deg, #17405c 0%, #132c49 46%); }',
    );
    expect(dark).toContain(
      '.t-plus { background: linear-gradient(180deg, #3d2f22 0%, #2a241f 46%);',
    );
    expect(dark).toContain(
      '.t-max { background: linear-gradient(180deg, #0a1430 0%, #070f24 100%);',
    );
    expect(css('globals.css')).toContain(
      ':root[data-theme="dark"] .logo-tile { box-shadow: 0 0 0 1px rgb(247 244 236 / 0.22); }',
    );
  });

  it('keeps ink, body, meta, amber and focus at AA on the night grounds', () => {
    for (const [fg, bg] of [
      [INK, PAGE],
      [BODY, PAGE],
      [BODY, CARD],
      [META, PAGE],
      [META, CARD],
      [AMBER, PAGE],
      [AMBER, CARD],
      [FOCUS, PAGE],
      [PAGE, INK],
      ['#9fd0ea', '#17405c'],
      ['#e9c79a', '#3d2f22'],
      ['#c9d2e6', '#0a1430'],
      ['#0a84ff', '#000000'],
      ['#ffffff', '#262628'],
    ] as const) {
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
