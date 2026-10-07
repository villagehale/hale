import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The connect sheet's dark ladder hangs off `.dark` (the class `hale-theme`
 * resolves to). These pairs are the text a parent actually reads, checked
 * against WCAG AA for normal text (4.5:1).
 */

const css = readFileSync(join(__dirname, 'connect.module.css'), 'utf8');

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

const darkBlock = css.slice(css.indexOf(':global(.dark) .stage {'));

describe('connect dark tokens', () => {
  it('hangs the approved night palette off .dark', () => {
    expect(darkBlock).toContain('--page: #0c1a36');
    expect(darkBlock).toContain('--band: #101f3f');
    expect(darkBlock).toContain('--card: #17294a');
    expect(darkBlock).toContain('--navy: #f7f4ec');
    expect(darkBlock).toContain('--slate: #b7c4dc');
    expect(darkBlock).toContain('--meta: #9eadc9');
    expect(darkBlock).toContain('--amber: #e2a75a');
    expect(darkBlock).toContain('--amber-tint: rgb(226 167 90 / 0.1)');
    expect(darkBlock).toContain('--amber-ring: rgb(226 167 90 / 0.55)');
    expect(darkBlock).toContain('--focus: #9fd0ea');
  });

  it('keeps Google’s dark-theme pill on the dark page', () => {
    const gsi = darkBlock.slice(darkBlock.indexOf(':global(.dark) .stage .gsi {'));
    expect(gsi).toContain('background: #131314');
    expect(gsi).toContain('box-shadow: inset 0 0 0 1px #8e918f');
    expect(gsi).toContain('color: #e3e3e3');
  });

  it('dims the shore and uses the night iMessage bubble', () => {
    expect(darkBlock).toContain('saturate(0.8) brightness(0.72) hue-rotate(-8deg)');
    expect(darkBlock).toContain('opacity: 0.22');
    expect(darkBlock).toContain('opacity: 0.14');
    expect(darkBlock).toContain('background: #262628');
    expect(darkBlock).toContain('color: #ffffff');
    expect(darkBlock).toContain('box-shadow: 0 0 0 1px rgb(247 244 236 / 0.22)');
  });
});

describe('connect dark contrast (WCAG AA)', () => {
  const surfaces = {
    page: '#0c1a36',
    band: '#101f3f',
    card: '#17294a',
  } as const;
  const inks = {
    ink: '#f7f4ec',
    body: '#b7c4dc',
    meta: '#9eadc9',
  } as const;

  for (const [inkName, ink] of Object.entries(inks)) {
    for (const [surfaceName, surface] of Object.entries(surfaces)) {
      it(`${inkName} on ${surfaceName} clears ${AA}:1`, () => {
        expect(contrast(ink, surface)).toBeGreaterThanOrEqual(AA);
      });
    }
  }

  it('amber on the card clears AA', () => {
    expect(contrast('#e2a75a', surfaces.card)).toBeGreaterThanOrEqual(AA);
  });

  it('the Google dark pill and the night bubble clear AA', () => {
    expect(contrast('#e3e3e3', '#131314')).toBeGreaterThanOrEqual(AA);
    expect(contrast('#ffffff', '#262628')).toBeGreaterThanOrEqual(AA);
    expect(contrast('#0c1a36', '#f7f4ec')).toBeGreaterThanOrEqual(AA);
  });
});
