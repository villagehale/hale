import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A structural WCAG gate on the palette tokens the app's text roles ride on. The
 * meta / caption / disclaimer text (`--color-faded-sage`, plus the secondary
 * `--color-slate-green`) is rendered on all three neutral surfaces — the canvas
 * (`--color-linen`), the card surface (`--color-oat`), and the raised surface
 * (`--color-raised`). WCAG AA for normal-size text is 4.5:1, so every one of those
 * pairs must clear 4.5:1 in BOTH themes. This guards the specific regression where
 * faded-sage passed on Linen but failed (4.39:1) on the darker Oat card surface.
 *
 * Ratios are derived from the WCAG 2.x relative-luminance formula, not copied from
 * whatever the tokens currently produce.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../../app/globals.css', import.meta.url)),
  'utf8',
);

/** WCAG relative luminance of an #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The light palette lives in the first `@theme { … }` block; the dark palette
 * re-points the same token names inside `.dark { … }`. Read a token from whichever
 * block, taking the FIRST hex assignment within it (the base value, before any
 * scoped overrides like the Prussian chrome frame further down the file).
 */
function tokensIn(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, hex] of block.matchAll(/--(color-[\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (name && hex && !(name in out)) out[name] = hex.toLowerCase();
  }
  return out;
}

function block(open: RegExp): string {
  const start = CSS.search(open);
  if (start === -1) throw new Error(`palette block not found: ${open}`);
  const from = CSS.indexOf('{', start) + 1;
  // Balanced-brace scan so nested rules don't truncate the block early.
  let depth = 1;
  let i = from;
  while (i < CSS.length && depth > 0) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') depth--;
    i++;
  }
  return CSS.slice(from, i - 1);
}

const LIGHT = tokensIn(block(/@theme\s*\{/));
const DARK = tokensIn(block(/\.dark\s*\{/));

const AA = 4.5;
const SURFACES = ['color-linen', 'color-oat', 'color-raised'] as const;
const TEXT_ON_SURFACE = ['color-faded-sage', 'color-slate-green'] as const;

describe.each([
  ['light', LIGHT] as const,
  ['dark', DARK] as const,
])('%s palette — meta/caption text clears WCAG AA on every neutral surface', (_mode, palette) => {
  for (const text of TEXT_ON_SURFACE) {
    for (const surface of SURFACES) {
      it(`${text} on ${surface} ≥ ${AA}:1`, () => {
        const ink = palette[text];
        const ground = palette[surface];
        // A missing token is itself a failure — the palette must define both.
        expect(ink, `${text} is defined`).toBeDefined();
        expect(ground, `${surface} is defined`).toBeDefined();
        expect(contrast(ink as string, ground as string)).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});
