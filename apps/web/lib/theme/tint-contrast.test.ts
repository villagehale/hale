import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the light-mode text-on-tint AA fixes (W2b polish a + b): the attach-chip
 * text and the Hale-tip eyebrow/link sit on a WARM tint, where the base accent hues
 * (tuned for white) drop below 4.5:1. The darker `-ink` tokens must restore ≥4.5:1.
 * This reads the REAL token values from globals.css so a future edit that reverts
 * them to a low-contrast colour fails here. Values are the first (light @theme)
 * occurrence — the `.dark` overrides come later in the file.
 */

const CSS = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

/** First (light) hex value of a CSS custom property. */
function tokenHex(name: string): string {
  const match = CSS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`token --${name} not found in globals.css`);
  return match[1];
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 0xff);
  const g = channel((n >> 8) & 0xff);
  const b = channel(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
/** The darker endpoint of the Hale-tip cream gradient (design handoff) — the
 * worst-case background the eyebrow/link sit on. */
const TIP_GRADIENT_DARK = '#FBEDDC';

describe('attach-chip text on its tint clears AA in light mode (W2b polish b)', () => {
  it.each([
    ['berry', 'color-berry-ink', 'color-berry-tint'],
    ['sage', 'color-sage-ink', 'color-sage-tint'],
    ['amber', 'color-amber-ink', 'color-amber-tint'],
  ])('%s ink on %s tint ≥ 4.5:1', (_name, ink, tint) => {
    expect(contrast(tokenHex(ink), tokenHex(tint))).toBeGreaterThanOrEqual(AA);
  });

  it('the unchanged apricot chip still clears AA (regression guard)', () => {
    expect(
      contrast(tokenHex('color-apricot-deep'), tokenHex('color-apricot-tint')),
    ).toBeGreaterThanOrEqual(AA);
  });
});

describe('Hale-tip amber ink on the cream gradient clears AA in light mode (W2b polish a)', () => {
  it('amber ink on the darker gradient endpoint ≥ 4.5:1', () => {
    expect(contrast(tokenHex('color-amber-ink'), TIP_GRADIENT_DARK)).toBeGreaterThanOrEqual(AA);
  });

  it('the base amber it replaced was BELOW AA there (proves the fix was needed)', () => {
    expect(contrast(tokenHex('color-amber'), TIP_GRADIENT_DARK)).toBeLessThan(AA);
  });
});
