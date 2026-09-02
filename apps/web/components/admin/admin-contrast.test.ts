import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mutation-proof for the admin surface's two ladders: parse the REAL tokens
 * out of admin.css (light block + `.dark` block) and compute WCAG contrast.
 * If someone dims an ink, lightens a panel, or deletes the dark ladder, this
 * fails — the "light board in a dark shell" defect becomes unexpressible.
 */

const css = readFileSync(join(__dirname, '../../app/(authed)/admin/admin.css'), 'utf8');

function tokensOf(block: string): Record<string, string> {
  const match = css.match(new RegExp(`${block}\\s*\\{([^}]+)\\}`));
  if (!match?.[1]) throw new Error(`token block not found: ${block}`);
  const out: Record<string, string> = {};
  for (const [, name, value] of match[1].matchAll(/(--adm-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (name && value) out[name] = value;
  }
  return out;
}

const light = tokensOf(`\\[data-surface='admin'\\]`);
const dark = tokensOf(`\\.dark \\[data-surface='admin'\\]`);

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function ratios(tokens: Record<string, string>) {
  const t = (name: string): string => {
    const v = tokens[name];
    if (!v) throw new Error(`missing token ${name}`);
    return v;
  };
  return {
    inkOnCard: contrast(t('--adm-ink'), t('--adm-card')),
    inkOnCanvas: contrast(t('--adm-ink'), t('--adm-canvas')),
    ink2OnCard: contrast(t('--adm-ink-2'), t('--adm-card')),
    ink3OnCard: contrast(t('--adm-ink-3'), t('--adm-card')),
    failOnCard: contrast(t('--adm-fail'), t('--adm-card')),
    ink2OnWash: contrast(t('--adm-ink-2'), t('--adm-wash')),
    tabLabelOnAmber: contrast(t('--adm-canvas'), t('--adm-amber')),
  };
}

describe('admin light ladder (the designed state — must not regress)', () => {
  const r = ratios(light);
  it('body ink clears AA on the panel surface', () => {
    expect(r.inkOnCard).toBeGreaterThanOrEqual(4.5);
    expect(r.inkOnCanvas).toBeGreaterThanOrEqual(4.5);
  });
  it('secondary + tertiary ink and the fail color clear AA on panels', () => {
    expect(r.ink2OnCard).toBeGreaterThanOrEqual(4.5);
    expect(r.ink3OnCard).toBeGreaterThanOrEqual(4.5);
    expect(r.failOnCard).toBeGreaterThanOrEqual(4.5);
    expect(r.ink2OnWash).toBeGreaterThanOrEqual(4.5);
  });
  it('the board is a light surface (luminance sanity — canvas near-white)', () => {
    expect(luminance(light['--adm-canvas'] as string)).toBeGreaterThan(0.8);
  });
});

describe('admin dark ladder (.dark — the board must not float light)', () => {
  const r = ratios(dark);
  it('body ink clears AA on the panel surface', () => {
    expect(r.inkOnCard).toBeGreaterThanOrEqual(4.5);
    expect(r.inkOnCanvas).toBeGreaterThanOrEqual(4.5);
  });
  it('secondary + tertiary ink and the lightened brick clear AA on panels', () => {
    expect(r.ink2OnCard).toBeGreaterThanOrEqual(4.5);
    expect(r.ink3OnCard).toBeGreaterThanOrEqual(4.5);
    expect(r.failOnCard).toBeGreaterThanOrEqual(4.5);
    expect(r.ink2OnWash).toBeGreaterThanOrEqual(4.5);
  });
  it('the active tab/dial label (canvas-on-amber fill) clears AA', () => {
    expect(r.tabLabelOnAmber).toBeGreaterThanOrEqual(4.5);
  });
  it('the board sits on the navy ladder, not a light cream (THE screenshot defect)', () => {
    expect(luminance(dark['--adm-canvas'] as string)).toBeLessThan(0.05);
    expect(luminance(dark['--adm-card'] as string)).toBeLessThan(0.05);
  });
  it('the band keeps a navy ground with AA cream ink on it', () => {
    const band = css.match(
      /\.dark \[data-surface='admin'\] \.adm-band\s*\{[^}]*background:\s*(#[0-9a-fA-F]{6})/,
    )?.[1];
    if (!band) throw new Error('dark .adm-band override not found');
    expect(luminance(band)).toBeLessThan(0.05);
    expect(contrast(dark['--adm-ink'] as string, band)).toBeGreaterThanOrEqual(4.5);
  });
});
